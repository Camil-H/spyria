import type { MessageRow, Store } from '@hq/db'
import type { MessageId } from '@hq/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { ChatNotFound, MessageNotFound } from '../domain/errors.ts'
import type { Message } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

const toDate = (iso: string | null) => (iso ? new Date(iso) : null)
const toMessage = ({ needsReply, ...row }: MessageRow): Message => ({
  ...row,
  body: MessageBody(row.body),
  createdAt: new Date(row.createdAt),
  editedAt: toDate(row.editedAt),
  deletedAt: toDate(row.deletedAt),
  replyToId: null,
})
const toRow = ({ replyToId, ...message }: Message, needsReply: boolean): MessageRow => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
  editedAt: message.editedAt?.toISOString() ?? null,
  deletedAt: message.deletedAt?.toISOString() ?? null,
  needsReply,
})

export const createStoreTransactor = (store: Store): ConversationTransactor => ({
  run: async (work) => {
    const initial = store.read()
    let { messages, readMarkers } = initial
    const updateRow = (messageId: MessageId, update: (row: MessageRow) => MessageRow) => {
      messages = messages.map((row) => (row.id === messageId ? update(row) : row))
    }
    const unitOfWork: UnitOfWork = {
      messages: {
        get: async (messageId) => {
          const row = messages.find((candidate) => candidate.id === messageId)
          if (!row) throw new MessageNotFound(messageId)
          return toMessage(row)
        },
        record: async ({ type, message }) => {
          if (type === 'message.edited' || type === 'message.deleted')
            return updateRow(message.id, (row) => toRow(message, row.needsReply))
          if (type === 'message.replied' && message.replyToId)
            updateRow(message.replyToId, (row) => ({ ...row, needsReply: false }))
          const index =
            messages.findIndex((row) => row.id === message.replyToId && row.chatId === message.chatId) + 1 ||
            messages.length
          messages = [...messages.slice(0, index), toRow(message, false), ...messages.slice(index)]
        },
        idsInChat: async (chatId) => messages.filter((row) => row.chatId === chatId).map((row) => row.id),
      },
      agentReplies: {
        request: async (message) => updateRow(message.id, (row) => ({ ...row, needsReply: true })),
      },
      readMarkers: {
        get: async (chatId, memberId) =>
          readMarkers.find((row) => row.chatId === chatId && row.memberId === memberId)?.lastReadMessageId ?? null,
        save: async (marker) => {
          readMarkers = [
            ...readMarkers.filter((row) => row.chatId !== marker.chatId || row.memberId !== marker.memberId),
            marker,
          ]
        },
      },
      chats: {
        get: async (chatId) => {
          const row = initial.chats.find((candidate) => candidate.id === chatId)
          if (!row) throw new ChatNotFound(chatId)
          return { id: row.id, workspaceId: row.workspaceId, type: row.type }
        },
      },
    }
    const result = await work(unitOfWork)
    if (messages !== initial.messages || readMarkers !== initial.readMarkers)
      store.write((current) => ({ ...current, messages, readMarkers }))
    return result
  },
})
