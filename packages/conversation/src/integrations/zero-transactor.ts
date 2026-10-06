import {
  appendChatEvent,
  enqueueJob,
  isChatEventStored,
  lastAgentEventTimestamp,
  lockChatTurn,
  nextPendingPrompt,
} from '@hq/db/server-writes'
import type { Message as MessageRow } from '@hq/db/zero'
import { zql } from '@hq/db/zero-queries'
import { type ChatId, chatId, type MessageId, memberId, messageId, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { ChatNotFound, ForeignWorkspace, MessageNotFound } from '../domain/errors.ts'
import type { Message, MessageChange } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import type { AgentEventPayload, ChangedPayload, PostedPayload } from '../domain/message-events.ts'

export const agentPromptJobType = 'agent.prompt'

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
})

const isPosted = (type: MessageChange['type']) => type === 'message.posted' || type === 'message.replied'

const payloadOf = ({
  type,
  message,
}: MessageChange): PostedPayload | ChangedPayload | Pick<ChangedPayload, 'messageId'> =>
  isPosted(type)
    ? { kind: message.kind, body: message.body, detail: message.detail, replyToId: message.replyToId }
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
  const messageRow = (id: string) => tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('id', id).one())
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
      setDetail: async (id, detail) => {
        if (await messageRow(id)) await tx.mutate.messages.update({ workspaceId: contextWorkspaceId, id, detail })
      },
    },
    agentPrompts: {
      request: async (message) => {
        await enqueueJob(tx, {
          workspaceId: message.workspaceId,
          type: agentPromptJobType,
          payload: { messageId: message.id },
          delayMilliseconds: 0,
        })
      },
    },
    agentTurns: {
      lock: async (id) => {
        const promptId = await lockChatTurn(tx, contextWorkspaceId, id)
        return promptId ? messageId(promptId) : null
      },
      set: (id, promptId) =>
        tx.mutate.chats.update({ workspaceId: contextWorkspaceId, id, agentTurnMessageId: promptId }),
      nextPrompt: async (id) => {
        const promptId = await nextPendingPrompt(tx, contextWorkspaceId, id)
        return promptId === undefined ? undefined : getMessage(messageId(promptId))
      },
      hasReply: async (promptId) =>
        (await tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('replyToId', promptId).one())) !==
        undefined,
    },
    agentEvents: {
      append: async (id, event, replyToId, at) => {
        if (tx.location !== 'server' || (await isChatEventStored(tx, contextWorkspaceId, event.id))) return undefined
        const payload: AgentEventPayload = { replyToId, event }
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
      lastTimestamp: (id) => lastAgentEventTimestamp(tx, contextWorkspaceId, id),
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
    },
    chats: {
      get: async (id) => {
        const row = await tx.run(zql.chats.where('workspaceId', contextWorkspaceId).where('id', id).one())
        if (!row) throw new ChatNotFound(id)
        return { workspaceId: workspaceId(row.workspaceId), type: row.type }
      },
    },
  }
  return { run: (work) => work(unitOfWork) }
}

export type Transact = <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>

export const createTransactingZeroTransactor = (
  transact: Transact,
  workspaceId: WorkspaceId,
): ConversationTransactor => ({
  run: (work) => transact((tx) => createZeroTransactor(tx, workspaceId).run(work)),
})
