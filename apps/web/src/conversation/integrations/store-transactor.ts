import type { DraftRow, MessageRow, Store } from '@hq/db'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { ChatNotFound, MessageNotFound } from '../domain/errors.ts'
import type { Message } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

const toDate = (iso: string | null) => (iso ? new Date(iso) : null)
const toMessage = (row: MessageRow): Message => ({
  ...row,
  body: MessageBody(row.body),
  createdAt: new Date(row.createdAt),
  editedAt: toDate(row.editedAt),
  deletedAt: toDate(row.deletedAt),
})
const toRow = (message: Message): MessageRow => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
  editedAt: message.editedAt?.toISOString() ?? null,
  deletedAt: message.deletedAt?.toISOString() ?? null,
})
const isSameDraftOwner = (draft: DraftRow, chatId: string, memberId: string) =>
  draft.chatId === chatId && draft.memberId === memberId

export const createStoreTransactor = (store: Store): ConversationTransactor => ({
  run: async (work) => {
    const initial = store.read()
    let { messages, drafts, readMarkers } = initial
    const unitOfWork: UnitOfWork = {
      messages: {
        get: async (messageId) => {
          const row = messages.find((candidate) => candidate.id === messageId)
          if (!row) throw new MessageNotFound(messageId)
          return toMessage(row)
        },
        add: async (message) => {
          messages = [...messages, toRow(message)]
        },
        insertAfter: async (message, previousMessageId) => {
          const index = messages.findIndex((row) => row.id === previousMessageId) + 1
          messages = [...messages.slice(0, index), toRow(message), ...messages.slice(index)]
        },
        save: async (message) => {
          messages = messages.map((row) => (row.id === message.id ? toRow(message) : row))
        },
        idsInChat: async (chatId) => messages.filter((row) => row.chatId === chatId).map((row) => row.id),
      },
      drafts: {
        save: async (draft) => {
          const stored = drafts.find((row) => isSameDraftOwner(row, draft.chatId, draft.memberId))
          if (stored?.text === draft.text) return
          drafts = [...drafts.filter((row) => row !== stored), draft]
        },
        remove: async (chatId, memberId) => {
          if (drafts.some((row) => isSameDraftOwner(row, chatId, memberId)))
            drafts = drafts.filter((row) => !isSameDraftOwner(row, chatId, memberId))
        },
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
    if (messages !== initial.messages || drafts !== initial.drafts || readMarkers !== initial.readMarkers)
      store.write((current) => ({ ...current, messages, drafts, readMarkers }))
    return result
  },
})
