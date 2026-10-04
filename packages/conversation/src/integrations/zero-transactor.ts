import { type Message as MessageRow, zql } from '@hq/db/zero'
import { type ChatId, chatId, type MessageId, memberId, messageId, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { ChatNotFound, ForeignWorkspace, MessageNotFound } from '../domain/errors.ts'
import type { Message, MessageChange } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
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

const eventOf = ({ type, message }: MessageChange) =>
  type === 'message.posted' || type === 'message.replied'
    ? {
        id: message.id,
        payload: { kind: message.kind, body: message.body, detail: message.detail, replyToId: message.replyToId },
      }
    : {
        id: crypto.randomUUID(),
        payload: type === 'message.edited' ? { messageId: message.id, body: message.body } : { messageId: message.id },
      }

export const createZeroTransactor = (tx: Transaction, contextWorkspaceId: WorkspaceId): ConversationTransactor => {
  const serverQuery = async (statement: string, parameters: unknown[]) =>
    tx.location === 'server' ? [...(await tx.dbTransaction.query(statement, parameters))] : []
  const findMessage = (id: MessageId) =>
    tx.run(zql.messages.where('workspaceId', contextWorkspaceId).where('id', id).one())
  const messagesInChat = (id: ChatId) =>
    zql.messages.where('workspaceId', contextWorkspaceId).where('chatId', id).orderBy('seq', 'asc')
  const nextSeqLockingChat = async (id: ChatId) => {
    if (tx.location === 'client') return ((await tx.run(messagesInChat(id).orderBy('seq', 'desc').one()))?.seq ?? 0) + 1
    const lockedChats = await serverQuery('select 1 from chats where workspace_id = $1 and id = $2 for update', [
      contextWorkspaceId,
      id,
    ])
    if (lockedChats.length === 0) throw new ChatNotFound(id)
    const [next] = await serverQuery(
      'select coalesce(max(seq), 0) + 1 as seq from events where workspace_id = $1 and chat_id = $2',
      [contextWorkspaceId, id],
    )
    return Number((next as { seq: number }).seq)
  }
  const inContextWorkspace = (message: Message) => {
    if (message.workspaceId !== contextWorkspaceId) throw new ForeignWorkspace()
    return message
  }
  const unitOfWork: UnitOfWork = {
    messages: {
      get: async (id) => {
        const row = await findMessage(id)
        if (!row) throw new MessageNotFound(id)
        return toMessage(row)
      },
      record: async (change) => {
        const { type, actorId } = change
        const message = inContextWorkspace(change.message)
        const seq = await nextSeqLockingChat(message.chatId)
        if (type === 'message.posted' || type === 'message.replied')
          await tx.mutate.messages.insert({
            ...message,
            seq,
            createdAt: message.createdAt.getTime(),
            editedAt: null,
            deletedAt: null,
          })
        else
          await tx.mutate.messages.update({
            workspaceId: message.workspaceId,
            id: message.id,
            body: message.deletedAt === null ? message.body : '',
            editedAt: timeOrNull(message.editedAt),
            deletedAt: timeOrNull(message.deletedAt),
          })
        const event = eventOf(change)
        await serverQuery(
          'insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at) values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())',
          [message.workspaceId, message.chatId, event.id, seq, type, actorId, JSON.stringify(event.payload)],
        )
      },
      idsInChat: async (id) => (await tx.run(messagesInChat(id))).map((row) => messageId(row.id)),
    },
    agentReplies: {
      request: async (message) => {
        await serverQuery(
          `insert into jobs (workspace_id, id, type, payload, run_at, attempts, state) values ($1, $2, $3, $4::jsonb, now() + make_interval(secs => $5::double precision / 1000), 0, 'queued')`,
          [
            message.workspaceId,
            crypto.randomUUID(),
            scriptedAgentReply.jobType,
            JSON.stringify({ messageId: message.id }),
            scriptedAgentReply.delayMilliseconds,
          ],
        )
      },
    },
    readMarkers: {
      get: async (id, readerId) => {
        const marker = await tx.run(
          zql.readMarkers.where('workspaceId', contextWorkspaceId).where('userId', readerId).where('chatId', id).one(),
        )
        if (!marker) return null
        const lastRead = await tx.run(messagesInChat(id).where('seq', marker.lastReadSeq).one())
        return lastRead ? messageId(lastRead.id) : null
      },
      save: async (marker) => {
        const lastRead = await findMessage(marker.lastReadMessageId)
        if (!lastRead || lastRead.chatId !== marker.chatId) throw new MessageNotFound(marker.lastReadMessageId)
        const stored = await tx.run(
          zql.readMarkers
            .where('workspaceId', contextWorkspaceId)
            .where('userId', marker.memberId)
            .where('chatId', marker.chatId)
            .one(),
        )
        if (stored && stored.lastReadSeq >= lastRead.seq) return
        await tx.mutate.readMarkers.upsert({
          workspaceId: contextWorkspaceId,
          userId: marker.memberId,
          chatId: marker.chatId,
          lastReadSeq: lastRead.seq,
        })
      },
    },
    chats: {
      get: async (id) => {
        const row = await tx.run(zql.chats.where('workspaceId', contextWorkspaceId).where('id', id).one())
        if (!row) throw new ChatNotFound(id)
        return { id: chatId(row.id), workspaceId: workspaceId(row.workspaceId), type: row.type }
      },
    },
  }
  return { run: (work) => work(unitOfWork) }
}
