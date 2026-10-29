import type { Transaction } from '@rocicorp/zero'
import {
  activeAgentTurns,
  appendChatEvent,
  chatEventsOf,
  chatRoutingOf,
  chatTurnOf,
  deleteMessageAttachments,
  enqueueJob,
  insertAttachment,
  insertDelegation,
  insertRoutingDecision,
  insertToolCall,
  isChatEventStored,
  isSessionStartPending,
  keepDeletedMessageText,
  lastAgentEvent,
  lastSessionId,
  linkAttachments,
  listedModelsOf,
  lockChatTurn,
  lockPendingAttachments,
  memberModelsOf,
  openTaskStepsOf,
  pendingPrompts,
  redactDeletedMessageEvents,
  runningDelegationOfTokenHash,
  setChatAgentModel,
  setChatTurnFailure,
  setChatTurnPrompter,
  setDelegationFields,
  stopRunningDelegations,
  storedAttachmentBytesOf,
} from '@spyria/db/server-writes'
import type { Message as MessageRow } from '@spyria/db/zero'
import {
  chatPermissionsOf,
  isOwnerRemoved,
  type Transact,
  transactingTransactor,
  transactorOver,
  zql,
} from '@spyria/db/zero-queries'
import {
  type ChatId,
  ChatNotFound,
  type ChatPermission,
  chatId,
  ForeignWorkspace,
  type HarnessId,
  type MemberId,
  type MessageId,
  memberId,
  messageId,
  type WorkspaceId,
  workspaceId,
} from '@spyria/kernel'
import { removeChatRuntimeOnServer, stopChatRuntimeOnServer } from '@spyria/runtime/published'
import type { ParticipantChange } from '../contracts/repositories.ts'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { agentJobTypes, agentSweepIntervalMilliseconds, waitingNotices } from '../domain/agent-events.ts'
import type { StoredStep } from '../domain/agent-steps.ts'
import { MessageNotFound } from '../domain/errors.ts'
import { agentActivityKinds, type Message, type MessageChange } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import {
  type AgentEventPayload,
  type ChangedPayload,
  messagesFromEvents,
  type PostedPayload,
  type StepChangedPayload,
} from '../domain/message-events.ts'

const dateOrNull = (time: number | null) => (time === null ? null : new Date(time))
const timeOrNull = (date: Date | null) => date?.getTime() ?? null

const toMessage = ({ seq, attachments, deletedAt, ...row }: MessageRow): Message => {
  const fields = {
    ...row,
    id: messageId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    chatId: chatId(row.chatId),
    authorId: row.authorId === null ? null : memberId(row.authorId),
    attachments: attachments ?? [],
    createdAt: new Date(row.createdAt),
    editedAt: dateOrNull(row.editedAt),
    replyToId: row.replyToId === null ? null : messageId(row.replyToId),
    threadRootId: row.threadRootId === null ? null : messageId(row.threadRootId),
    quotedMessageId: row.quotedMessageId === null ? null : messageId(row.quotedMessageId),
    step: row.step as StoredStep | null,
  }
  return deletedAt === null
    ? {
        ...fields,
        status: 'live',
        body: MessageBody(row.body, { allowsBlank: fields.attachments.length > 0 }),
      }
    : { ...fields, status: 'deleted', body: row.body as MessageBody, deletedAt: new Date(deletedAt) }
}

const withoutStatus = ({ status, ...message }: Message) => message

const advanceReadMarker = async (
  newest: { seq: number } | undefined,
  stored: { lastReadSeq: number } | undefined,
  write: (lastReadSeq: number) => Promise<void>,
) => {
  if (newest && !(stored && stored.lastReadSeq >= newest.seq)) await write(newest.seq)
}

const isPosted = (type: MessageChange['type']) => type === 'message.posted' || type === 'message.replied'

const payloadOf = ({
  type,
  message,
}: MessageChange): PostedPayload | ChangedPayload | StepChangedPayload | Pick<ChangedPayload, 'messageId'> =>
  isPosted(type)
    ? {
        kind: message.kind,
        body: message.body,
        detail: message.detail,
        replyToId: message.replyToId,
        ...(message.threadRootId && { threadRootId: message.threadRootId }),
        ...(message.quotedMessageId && { quotedMessageId: message.quotedMessageId }),
        ...(message.step && { step: message.step }),
        ...(message.attachments.length > 0 && { attachments: message.attachments }),
      }
    : type === 'message.edited'
      ? { messageId: message.id, body: message.body }
      : type === 'message.step_changed'
        ? { messageId: message.id, step: message.step }
        : { messageId: message.id }

export const createZeroTransactor = (tx: Transaction, contextWorkspaceId: WorkspaceId): ConversationTransactor => {
  const newestInChat = (id: ChatId) =>
    tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('chatId', id).orderBy('seq', 'desc').one())
  const appendEvent = async (change: MessageChange) => {
    const { message } = change
    if (tx.location === 'client') return ((await newestInChat(message.chatId))?.seq ?? 0) + 1
    return appendChatEvent(tx, {
      workspaceId: message.workspaceId,
      chatId: message.chatId,
      type: change.type,
      actor: change.actorId,
      payload: payloadOf(change),
      createdAt:
        change.type === 'message.step_changed'
          ? new Date()
          : message.status === 'deleted'
            ? message.deletedAt
            : (message.editedAt ?? message.createdAt),
      ...(isPosted(change.type) && { id: message.id }),
    })
  }
  const inContextWorkspace = (message: Message) => {
    if (message.workspaceId !== contextWorkspaceId) throw new ForeignWorkspace()
    return message
  }
  const repliesTo = (promptId: MessageId) =>
    zql.messages.where('workspaceId', contextWorkspaceId).where('replyToId', promptId)
  const participantRow = (id: ChatId, member: string) =>
    tx.run(
      zql.chatParticipants.where('workspaceId', contextWorkspaceId).where('chatId', id).where('userId', member).one(),
    )
  const changeParticipant = async ({ type, chatId: id, memberId: member, roleId, actorId }: ParticipantChange) => {
    const key = { workspaceId: contextWorkspaceId, chatId: id, userId: member }
    if (roleId === null) await tx.mutate.chatParticipants.delete(key)
    else await tx.mutate.chatParticipants.upsert({ ...key, roleId })
    if (tx.location === 'server')
      await appendChatEvent(tx, {
        workspaceId: contextWorkspaceId,
        chatId: id,
        type,
        actor: actorId,
        payload: { memberId: member, ...(roleId !== null && { roleId }) },
        createdAt: new Date(),
      })
  }
  const displayNamesOf = async (ids: readonly MemberId[]) => {
    const nameByMemberId = new Map(
      ids.length === 0
        ? []
        : (await tx.run(zql.memberships.where('workspaceId', contextWorkspaceId).where('userId', 'IN', [...ids]))).map(
            (membership) => [membership.userId, membership.displayName],
          ),
    )
    return (id: MemberId) => nameByMemberId.get(id) ?? 'a member'
  }
  const messageRow = (id: string) => tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('id', id).one())
  const enqueue = (type: string, payload: object, delayMilliseconds = 0) =>
    enqueueJob(tx, { workspaceId: contextWorkspaceId, type, payload, delayMilliseconds }).then(() => undefined)
  const waitingPromptIds = (id: ChatId) => pendingPrompts(tx, contextWorkspaceId, id, waitingNotices)
  const getMessage = async (id: MessageId) => {
    const row = await messageRow(id)
    if (!row) throw new MessageNotFound(id)
    return toMessage(row)
  }
  const rowOf = (message: Message) => ({
    ...withoutStatus(inContextWorkspace(message)),
    body: message.status === 'deleted' ? '' : message.body,
    createdAt: message.createdAt.getTime(),
    editedAt: timeOrNull(message.editedAt),
    deletedAt: message.status === 'deleted' ? message.deletedAt.getTime() : null,
  })
  const unitOfWork: UnitOfWork = {
    messages: {
      get: getMessage,
      record: async (change) => {
        const row = rowOf(change.message)
        const seq = await appendEvent(change)
        if (isPosted(change.type)) await tx.mutate.messages.insert({ ...row, seq })
        else await tx.mutate.messages.update(row)
        if (change.type === 'message.deleted' && change.message.status === 'deleted' && change.actorId) {
          const deleted = {
            workspaceId: contextWorkspaceId,
            chatId: change.message.chatId,
            messageId: change.message.id,
          }
          await keepDeletedMessageText(tx, {
            ...deleted,
            body: change.message.body,
            deletedBy: change.actorId,
            deletedAt: change.message.deletedAt,
          })
          await redactDeletedMessageEvents(tx, deleted)
        }
      },
      project: (message, seq) => tx.mutate.messages.insert({ ...rowOf(message), seq }),
      find: async (id) => {
        const row = await messageRow(id)
        return row && toMessage(row)
      },
      setStep: (id, step) => tx.mutate.messages.update({ workspaceId: contextWorkspaceId, id, step }),
      replies: async (promptId) => (await tx.run(repliesTo(promptId).orderBy('seq', 'asc'))).map(toMessage),
      openTaskSteps: (promptId) => openTaskStepsOf<StoredStep>(tx, contextWorkspaceId, promptId),
      thread: async (id, rootId) =>
        (
          await tx.run(
            zql.messages
              .where('workspaceId', contextWorkspaceId)
              .where('chatId', id)
              .where(({ or, cmp }) => or(cmp('id', rootId), cmp('threadRootId', rootId)))
              .orderBy('seq', 'asc'),
          )
        ).map(toMessage),
      history: async (id) =>
        messagesFromEvents(await chatEventsOf(tx, contextWorkspaceId, id))
          .filter((message) => message.kind === 'member' || message.kind === 'agent')
          .map(({ createdAt, editedAt, deletedAt, ...message }) =>
            toMessage({
              ...message,
              createdAt: createdAt.getTime(),
              editedAt: timeOrNull(editedAt),
              deletedAt: timeOrNull(deletedAt),
            }),
          ),
      pullRequestCard: async (id) => {
        const row = await tx.run(
          zql.messages
            .where('workspaceId', contextWorkspaceId)
            .where('chatId', id)
            .where('kind', 'step')
            .where('authorId', 'IS NOT', null)
            .orderBy('seq', 'desc')
            .one(),
        )
        return row?.step?.type === 'pull_request' ? toMessage(row) : undefined
      },
      seedFor: async (prompt) => {
        const memberMessages = zql.messages
          .where('workspaceId', contextWorkspaceId)
          .where('chatId', prompt.chatId)
          .where('kind', 'member')
          .orderBy('seq', 'asc')
        const [seed, firstLivePrompt, earlierTurnReply] = await Promise.all([
          tx.run(memberMessages.where('replyToId', 'IS NOT', null).where('deletedAt', 'IS', null).one()),
          tx.run(memberMessages.where('replyToId', 'IS', null).where('deletedAt', 'IS', null).one()),
          tx.run(
            zql.messages
              .where('workspaceId', contextWorkspaceId)
              .where('chatId', prompt.chatId)
              .where('kind', 'IN', agentActivityKinds)
              .where('authorId', 'IS', null)
              .where('replyToId', '!=', prompt.id)
              .orderBy('seq', 'asc')
              .one(),
          ),
        ])
        return seed && firstLivePrompt?.id === prompt.id && !earlierTurnReply ? toMessage(seed) : undefined
      },
    },
    attachments: {
      store: ({ chatId: id, uploaderId, ...attachment }) =>
        insertAttachment(tx, { ...attachment, workspaceId: contextWorkspaceId, chatId: id, uploaderId }).then(
          () => undefined,
        ),
      claim: async (id, uploaderId, requested) =>
        requested.length === 0 || tx.location === 'client'
          ? requested
          : lockPendingAttachments(tx, {
              workspaceId: contextWorkspaceId,
              chatId: id,
              uploaderId,
              ids: requested.map((attachment) => attachment.id),
            }),
      link: async (id, attachments) => {
        if (attachments.length > 0)
          await linkAttachments(
            tx,
            contextWorkspaceId,
            id,
            attachments.map((attachment) => attachment.id),
          )
      },
      discard: async (id) => {
        await deleteMessageAttachments(tx, contextWorkspaceId, id)
      },
      storedBytes: (uploaderId) => storedAttachmentBytesOf(tx, contextWorkspaceId, uploaderId),
    },
    agentJobs: {
      prompt: (message) => enqueue(agentJobTypes.prompt, { messageId: message.id }),
      startSession: (chatId) => enqueue(agentJobTypes.startSession, { chatId }),
      interrupt: (interrupt) => enqueue(agentJobTypes.interrupt, interrupt),
      restartSession: (restart) => enqueue(agentJobTypes.restartSession, restart),
      sweepLater: () => enqueue(agentJobTypes.sweep, {}, agentSweepIntervalMilliseconds),
    },
    members: {
      displayNameOf: async (id) => (await displayNamesOf([id]))(id),
      displayNamesOf,
      hasLlmCredential: async (id) =>
        (await tx.run(zql.llmCredentials.where('workspaceId', contextWorkspaceId).where('userId', id).one())) !==
        undefined,
      isMember: async (id) =>
        (await tx.run(
          zql.memberships
            .where('workspaceId', contextWorkspaceId)
            .where('userId', id)
            .where('removedAt', 'IS', null)
            .one(),
        )) !== undefined,
    },
    agentTurns: {
      lock: async (id) => {
        const promptId = await lockChatTurn(tx, contextWorkspaceId, id)
        return promptId ? messageId(promptId) : null
      },
      set: async (id, prompt) => {
        await tx.mutate.chats.update({ workspaceId: contextWorkspaceId, id, agentTurnMessageId: prompt?.id ?? null })
        await setChatTurnPrompter(tx, contextWorkspaceId, id, prompt?.authorId ?? null)
      },
      modelCallTurn: async (id) => {
        const turn = await chatTurnOf(tx, contextWorkspaceId, id)
        return turn?.promptId && turn.prompterId && !turn.localSession
          ? {
              promptId: messageId(turn.promptId),
              prompterId: memberId(turn.prompterId),
              ownerId: turn.ownerId === null ? null : memberId(turn.ownerId),
              sessionId: turn.sessionId,
            }
          : undefined
      },
      toolCallTurn: async (id) => {
        const turn = await chatTurnOf(tx, contextWorkspaceId, id)
        return {
          ownerId: turn?.ownerId ? memberId(turn.ownerId) : null,
          prompterId: turn?.promptId && turn.prompterId ? memberId(turn.prompterId) : null,
          promptId: turn?.promptId ? messageId(turn.promptId) : null,
        }
      },
      lastFailure: async (id) => (await chatTurnOf(tx, contextWorkspaceId, id))?.failure ?? null,
      recordFailure: async (id, promptId, notice) => {
        await setChatTurnFailure(tx, contextWorkspaceId, id, promptId, notice)
      },
      nextPrompt: async (id) => {
        const [promptId] = await waitingPromptIds(id)
        return promptId === undefined ? undefined : getMessage(messageId(promptId))
      },
      waitingPrompts: async (id) =>
        Promise.all((await waitingPromptIds(id)).map((promptId) => getMessage(messageId(promptId)))),
      hasReply: async (promptId) =>
        (await tx.run(repliesTo(promptId).where('kind', '!=', 'notice').one())) !== undefined,
      hasNotice: async (promptId, texts) =>
        (await tx.run(
          repliesTo(promptId)
            .where('kind', 'notice')
            .where('body', 'IN', [...texts])
            .one(),
        )) !== undefined,
      active: async () =>
        (await activeAgentTurns(tx, contextWorkspaceId)).map((turn) => ({
          chatId: chatId(turn.chatId),
          promptId: messageId(turn.promptId),
          lastEventAt: Number(turn.lastEventAt),
        })),
    },
    agentEvents: {
      append: async (id, event, replyToId, at, delegation) => {
        if (tx.location !== 'server' || (await isChatEventStored(tx, contextWorkspaceId, event.id))) return undefined
        const payload: AgentEventPayload = {
          replyToId,
          event,
          ...(delegation && { delegation }),
        }
        return appendChatEvent(tx, {
          workspaceId: contextWorkspaceId,
          chatId: id,
          id: event.id,
          type: 'agent.event',
          actor: null,
          payload,
          createdAt: at,
        })
      },
      last: async (id) => {
        const last = await lastAgentEvent(tx, contextWorkspaceId, id)
        return last && { ...last, replyToId: last.replyToId === null ? null : messageId(last.replyToId) }
      },
      lastSessionId: (id) => lastSessionId(tx, contextWorkspaceId, id),
    },
    browserPages: {
      open: (id, page, openedAt) =>
        tx.mutate.browserPages.upsert({
          workspaceId: contextWorkspaceId,
          chatId: id,
          ...page,
          openedAt: openedAt.getTime(),
        }),
    },
    routing: {
      chatRouting: async (id) => {
        const row = await chatRoutingOf(tx, contextWorkspaceId, id)
        if (!row) throw new ChatNotFound(id)
        return { ...row, ownerId: row.ownerId === null ? null : memberId(row.ownerId) }
      },
      reachableModels: (id) => memberModelsOf(tx, contextWorkspaceId, id),
      listedModels: listedModelsOf,
      update: (id, fields) =>
        tx.mutate.chats.update({
          workspaceId: contextWorkspaceId,
          id,
          ...(fields as Partial<{ subagentPolicy: 'auto' | 'same_as_main'; harness: HarnessId | null }>),
        }),
      setAgentModel: async (id, model, reasoningEffort) => {
        await setChatAgentModel(tx, contextWorkspaceId, id, model, reasoningEffort)
      },
      record: async (decision) => {
        await insertRoutingDecision(tx, { workspaceId: contextWorkspaceId, ...decision })
      },
    },
    toolCalls: {
      record: async (call) => {
        await insertToolCall(tx, { workspaceId: contextWorkspaceId, ...call })
      },
    },
    delegations: {
      start: async (delegation) => {
        await insertDelegation(tx, { workspaceId: contextWorkspaceId, ...delegation, status: 'running' })
      },
      update: async (id, fields) => {
        await setDelegationFields(tx, contextWorkspaceId, id, fields)
      },
      stopRunning: (id, promptId) => stopRunningDelegations(tx, contextWorkspaceId, id, promptId),
      runningOfTokenHash: async (hostId, tokenHash) => {
        const found = await runningDelegationOfTokenHash(tx, contextWorkspaceId, hostId, tokenHash)
        return found && { chatId: chatId(found.chatId), id: found.id, promptId: messageId(found.promptId) }
      },
    },
    readMarkers: {
      markNewestRead: async (id, readerId) => {
        const stored = await tx.run(
          zql.readMarkers.where('workspaceId', contextWorkspaceId).where('userId', readerId).where('chatId', id).one(),
        )
        await advanceReadMarker(await newestInChat(id), stored, (lastReadSeq) =>
          tx.mutate.readMarkers.upsert({ workspaceId: contextWorkspaceId, userId: readerId, chatId: id, lastReadSeq }),
        )
      },
      markThreadRead: async (id, threadRootId, readerId) => {
        const thread = { workspaceId: contextWorkspaceId, chatId: id, threadRootId }
        const newestReply = await tx.run(
          zql.messages
            .where('workspaceId', contextWorkspaceId)
            .where('chatId', id)
            .where('threadRootId', threadRootId)
            .orderBy('seq', 'desc')
            .one(),
        )
        const stored = await tx.run(
          zql.threadReadMarkers
            .where('workspaceId', contextWorkspaceId)
            .where('userId', readerId)
            .where('threadRootId', threadRootId)
            .one(),
        )
        await advanceReadMarker(newestReply, stored, (lastReadSeq) =>
          tx.mutate.threadReadMarkers.upsert({ ...thread, userId: readerId, lastReadSeq }),
        )
      },
    },
    chats: {
      get: async (id) => {
        const row = await tx.run(zql.chats.where('workspaceId', contextWorkspaceId).where('id', id).one())
        if (!row) throw new ChatNotFound(id)
        return {
          workspaceId: workspaceId(row.workspaceId),
          name: row.name,
          type: row.type,
          visibility: row.visibility,
          harness: row.harness ?? null,
          ownerId: row.ownerUserId ? memberId(row.ownerUserId) : null,
          localSession: row.localSession ?? null,
          baseBranch: row.baseBranch ?? null,
          isOwnerRemoved: await isOwnerRemoved(tx, contextWorkspaceId, row.ownerUserId),
        }
      },
      ...chatPermissionsOf(tx, contextWorkspaceId),
      join: async (id, member) => {
        if (!(await participantRow(id, member)))
          await changeParticipant({
            type: 'member.joined',
            chatId: id,
            memberId: member,
            roleId: 'prompter',
            actorId: member,
          })
      },
      roleOf: async (id, member) => (await participantRow(id, member))?.roleId,
      role: async (roleId) => {
        const row = await tx.run(zql.chatRoles.where('workspaceId', contextWorkspaceId).where('id', roleId).one())
        return row && { ...row, permissions: row.permissions as ChatPermission[] }
      },
      changeParticipant,
      recordRuntimeOrigin: (origin) => tx.mutate.runtimeOrigins.insert({ workspaceId: contextWorkspaceId, ...origin }),
      recordPush: async ({ chatId: id, actorId, branch, head }) => {
        if (tx.location === 'server')
          await appendChatEvent(tx, {
            workspaceId: contextWorkspaceId,
            chatId: id,
            type: 'branch.pushed',
            actor: actorId,
            payload: { branch, head },
            createdAt: new Date(),
          })
      },
      localSessionsAllowed: async () =>
        (await tx.run(zql.workspaces.where('workspaceId', contextWorkspaceId).one()))?.localSessions ?? true,
      hasAgentSession: async (id) =>
        Boolean(
          (await tx.run(zql.chats.where('workspaceId', contextWorkspaceId).where('id', id).one()))?.agentTurnMessageId,
        ) ||
        (await tx.run(
          zql.messages
            .where('workspaceId', contextWorkspaceId)
            .where('chatId', id)
            .where('kind', 'IN', agentActivityKinds)
            .where('authorId', 'IS', null)
            .orderBy('seq', 'asc')
            .one(),
        )) !== undefined ||
        (await lastAgentEvent(tx, contextWorkspaceId, id)) !== undefined,
      isSessionStartPending: (id) => isSessionStartPending(tx, contextWorkspaceId, id),
      dropRuntime: (id) => removeChatRuntimeOnServer(tx, contextWorkspaceId, id),
      stopRuntime: (id) => stopChatRuntimeOnServer(tx, contextWorkspaceId, id),
      hasMachine: async (id) =>
        (await tx.run(
          zql.runtimeHosts
            .where('workspaceId', contextWorkspaceId)
            .where('ownerId', id)
            .where('removedAt', 'IS', null)
            .one(),
        )) !== undefined,
    },
  }
  return transactorOver(tx, unitOfWork)
}

export const createTransactingZeroTransactor = (transact: Transact, workspaceId: WorkspaceId): ConversationTransactor =>
  transactingTransactor(transact, (tx) => createZeroTransactor(tx, workspaceId))
