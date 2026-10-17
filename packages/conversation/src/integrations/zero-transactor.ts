import {
  activeAgentTurns,
  appendChatEvent,
  chatRoutingOf,
  chatTurnOf,
  enqueueJob,
  insertDelegation,
  insertRoutingDecision,
  insertToolCall,
  isChatEventStored,
  isSessionStartPending,
  lastAgentEvent,
  lastSessionId,
  listedModelsOf,
  lockChatTurn,
  memberModelsOf,
  pendingPrompts,
  runningDelegationOfTokenHash,
  setChatAgentModel,
  setChatTurnFailure,
  setChatTurnPrompter,
  setDelegationFields,
  stopRunningDelegations,
} from '@hq/db/server-writes'
import type { Message as MessageRow } from '@hq/db/zero'
import { memberChatPermissions, type Transact, zql } from '@hq/db/zero-queries'
import {
  type ChatId,
  type ChatPermission,
  chatId,
  type MessageId,
  memberId,
  messageId,
  type WorkspaceId,
  workspaceId,
} from '@hq/kernel'
import { removeChatRuntimeOnServer } from '@hq/runtime/published'
import type { Transaction } from '@rocicorp/zero'
import type { ParticipantChange } from '../contracts/repositories.ts'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { agentJobTypes, agentSweepIntervalMilliseconds, waitingNotices } from '../domain/agent-events.ts'
import type { StoredStep } from '../domain/agent-steps.ts'
import { ChatNotFound, ForeignWorkspace, MessageNotFound } from '../domain/errors.ts'
import type { Message, MessageChange } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import type { AgentEventPayload, ChangedPayload, PostedPayload } from '../domain/message-events.ts'

const dateOrNull = (time: number | null) => (time === null ? null : new Date(time))
const timeOrNull = (date: Date | null) => date?.getTime() ?? null

const toMessage = ({ seq, ...row }: MessageRow): Message => ({
  ...row,
  id: messageId(row.id),
  workspaceId: workspaceId(row.workspaceId),
  chatId: chatId(row.chatId),
  authorId: row.authorId === null ? null : memberId(row.authorId),
  body: row.deletedAt === null ? MessageBody(row.body) : (row.body as MessageBody),
  createdAt: new Date(row.createdAt),
  editedAt: dateOrNull(row.editedAt),
  deletedAt: dateOrNull(row.deletedAt),
  replyToId: row.replyToId === null ? null : messageId(row.replyToId),
  threadRootId: row.threadRootId === null ? null : messageId(row.threadRootId),
  step: row.step as StoredStep | null,
})

const isPosted = (type: MessageChange['type']) => type === 'message.posted' || type === 'message.replied'

const payloadOf = ({
  type,
  message,
}: MessageChange): PostedPayload | ChangedPayload | Pick<ChangedPayload, 'messageId'> =>
  isPosted(type)
    ? {
        kind: message.kind,
        body: message.body,
        detail: message.detail,
        replyToId: message.replyToId,
        ...(message.threadRootId && { threadRootId: message.threadRootId }),
      }
    : type === 'message.edited'
      ? { messageId: message.id, body: message.body }
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
      createdAt: message.deletedAt ?? message.editedAt ?? message.createdAt,
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
    ...inContextWorkspace(message),
    body: message.deletedAt === null ? message.body : '',
    createdAt: message.createdAt.getTime(),
    editedAt: timeOrNull(message.editedAt),
    deletedAt: timeOrNull(message.deletedAt),
  })
  const unitOfWork: UnitOfWork = {
    messages: {
      get: getMessage,
      record: async (change) => {
        const row = rowOf(change.message)
        const seq = await appendEvent(change)
        if (isPosted(change.type)) await tx.mutate.messages.insert({ ...row, seq })
        else await tx.mutate.messages.update(row)
      },
      project: (message, seq) => tx.mutate.messages.insert({ ...rowOf(message), seq }),
      find: async (id) => {
        const row = await messageRow(id)
        return row && toMessage(row)
      },
      setStep: (id, step) => tx.mutate.messages.update({ workspaceId: contextWorkspaceId, id, step }),
      replies: async (promptId) => (await tx.run(repliesTo(promptId).orderBy('seq', 'asc'))).map(toMessage),
      thread: async (rootId) =>
        (
          await tx.run(
            zql.messages
              .where('workspaceId', contextWorkspaceId)
              .where(({ or, cmp }) => or(cmp('id', rootId), cmp('threadRootId', rootId)))
              .orderBy('seq', 'asc'),
          )
        ).map(toMessage),
      inChat: async (id) =>
        (
          await tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('chatId', id).orderBy('seq', 'asc'))
        ).map(toMessage),
      wrapperFor: async (prompt) => {
        const memberMessages = zql.messages
          .where('workspaceId', contextWorkspaceId)
          .where('chatId', prompt.chatId)
          .where('kind', 'member')
          .orderBy('seq', 'asc')
        const [wrapper, firstPrompt] = await Promise.all([
          tx.run(memberMessages.where('replyToId', 'IS NOT', null).where('deletedAt', 'IS', null).one()),
          tx.run(memberMessages.where('replyToId', 'IS', null).one()),
        ])
        return wrapper && firstPrompt?.id === prompt.id ? toMessage(wrapper) : undefined
      },
    },
    agentJobs: {
      prompt: (message) => enqueue(agentJobTypes.prompt, { messageId: message.id }),
      startSession: (chatId) => enqueue(agentJobTypes.startSession, { chatId }),
      interrupt: (interrupt) => enqueue(agentJobTypes.interrupt, interrupt),
      sweepLater: () => enqueue(agentJobTypes.sweep, {}, agentSweepIntervalMilliseconds),
    },
    members: {
      displayNameOf: async (id) =>
        (await tx.run(zql.memberships.where('workspaceId', contextWorkspaceId).where('userId', id).one()))
          ?.displayName ?? 'a member',
      hasLlmCredential: async (id) =>
        (await tx.run(zql.llmCredentials.where('workspaceId', contextWorkspaceId).where('userId', id).one())) !==
        undefined,
      isMember: async (id) =>
        (await tx.run(zql.memberships.where('workspaceId', contextWorkspaceId).where('userId', id).one())) !==
        undefined,
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
      hasNotice: async (promptId, text) =>
        (await tx.run(repliesTo(promptId).where('kind', 'notice').where('body', text).one())) !== undefined,
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
    plans: {
      replace: async (id, items) => {
        for (const { position } of await tx.run(
          zql.planSteps.where('workspaceId', contextWorkspaceId).where('chatId', id),
        ))
          await tx.mutate.planSteps.delete({ workspaceId: contextWorkspaceId, chatId: id, position })
        for (const [position, item] of items.entries())
          await tx.mutate.planSteps.insert({ workspaceId: contextWorkspaceId, chatId: id, position, ...item })
      },
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
          ...(fields as Partial<{ subagentPolicy: 'auto' | 'same_as_main'; harness: 'claude-code' | 'codex' | null }>),
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
        const newest = await newestInChat(id)
        const stored = await tx.run(
          zql.readMarkers.where('workspaceId', contextWorkspaceId).where('userId', readerId).where('chatId', id).one(),
        )
        if (!newest || (stored && stored.lastReadSeq >= newest.seq)) return
        await tx.mutate.readMarkers.upsert({
          workspaceId: contextWorkspaceId,
          userId: readerId,
          chatId: id,
          lastReadSeq: newest.seq,
        })
      },
      markThreadRead: async (id, threadRootId, readerId) => {
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
        if (!newestReply || (stored && stored.lastReadSeq >= newestReply.seq)) return
        await tx.mutate.threadReadMarkers.upsert({
          workspaceId: contextWorkspaceId,
          userId: readerId,
          chatId: id,
          threadRootId,
          lastReadSeq: newestReply.seq,
        })
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
          harness: row.harness ?? null,
          ownerId: row.ownerUserId ? memberId(row.ownerUserId) : null,
          localSession: row.localSession ?? null,
        }
      },
      permissions: (id, member) => memberChatPermissions(tx, contextWorkspaceId, id, member),
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
            .where('kind', 'IN', ['agent', 'step'])
            .one(),
        )) !== undefined ||
        (await lastAgentEvent(tx, contextWorkspaceId, id)) !== undefined,
      isSessionStartPending: (id) => isSessionStartPending(tx, contextWorkspaceId, id),
      setPlanning: async (id, isPlanning) => {
        const row = await tx.run(zql.chats.where('workspaceId', contextWorkspaceId).where('id', id).one())
        if (row && (row.isPlanning ?? false) !== isPlanning)
          await tx.mutate.chats.update({ workspaceId: contextWorkspaceId, id, isPlanning })
      },
      dropRuntime: (id) => removeChatRuntimeOnServer(tx, contextWorkspaceId, id),
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
  return { run: (work) => work(unitOfWork) }
}

export const createTransactingZeroTransactor = (
  transact: Transact,
  workspaceId: WorkspaceId,
): ConversationTransactor => ({
  run: (work) => transact((tx) => createZeroTransactor(tx, workspaceId).run(work)),
})
