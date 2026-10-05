import { appendChatEvent, enqueueJob } from '@hq/db/server-writes'
import type { Message as MessageRow } from '@hq/db/zero'
import { zql } from '@hq/db/zero-queries'
import { type ChatId, chatId, type MessageId, memberId, messageId, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { ChatNotFound, ForeignWorkspace, MessageNotFound } from '../domain/errors.ts'
import type { Message, MessageChange } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import type { ChangedPayload, PostedPayload } from '../domain/message-events.ts'
import { scriptedAgentReply } from '../domain/scripted-agent.ts'

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
  const unitOfWork: UnitOfWork = {
    messages: {
      get: async (id) => {
        const row = await tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('id', id).one())
        if (!row) throw new MessageNotFound(id)
        return toMessage(row)
      },
      record: async (change) => {
        const message = inContextWorkspace(change.message)
        const seq = await appendEvent(change)
        const row = {
          ...message,
          body: message.deletedAt === null ? message.body : '',
          createdAt: message.createdAt.getTime(),
          editedAt: timeOrNull(message.editedAt),
          deletedAt: timeOrNull(message.deletedAt),
        }
        if (isPosted(change.type)) await tx.mutate.messages.insert({ ...row, seq })
        else await tx.mutate.messages.update(row)
      },
    },
    agentReplies: {
      request: async (message) => {
        await enqueueJob(tx, {
          workspaceId: message.workspaceId,
          type: scriptedAgentReply.jobType,
          payload: { messageId: message.id },
          delayMilliseconds: scriptedAgentReply.delayMilliseconds,
        })
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
