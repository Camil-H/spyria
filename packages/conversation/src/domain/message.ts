import type { ChatId, MemberId, MessageId, WorkspaceId } from '@hq/kernel'
import { MessageDeleted, NotMessageAuthor } from './errors.ts'
import type { MessageBody } from './message-body.ts'

export type Message = Readonly<{
  id: MessageId
  workspaceId: WorkspaceId
  chatId: ChatId
  kind: 'member' | 'agent' | 'tool-call'
  authorId: MemberId | null
  body: MessageBody
  detail: string | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  needsReply: boolean
}>

export type ConversationChat = Readonly<{ id: ChatId; workspaceId: WorkspaceId; type: 'channel' | 'runtime' }>

const assertChangeable = (message: Message, memberId: MemberId) => {
  if (message.authorId !== memberId) throw new NotMessageAuthor()
  if (message.deletedAt) throw new MessageDeleted()
}

export const editMessage = (message: Message, editorId: MemberId, body: MessageBody, at: Date): Message => {
  assertChangeable(message, editorId)
  return { ...message, body, editedAt: at }
}

export const deleteMessage = (message: Message, deleterId: MemberId, at: Date): Message => {
  assertChangeable(message, deleterId)
  return { ...message, deletedAt: at }
}

export const newMessage = (
  fields: Pick<Message, 'id' | 'workspaceId' | 'chatId' | 'kind' | 'authorId' | 'body' | 'createdAt' | 'needsReply'>,
): Message => ({ ...fields, detail: null, editedAt: null, deletedAt: null })
