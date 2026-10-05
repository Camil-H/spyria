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
  replyToId: MessageId | null
}>

export type MessageChange = Readonly<{
  type: 'message.posted' | 'message.replied' | 'message.edited' | 'message.deleted'
  actorId: MemberId | null
  message: Message
}>

export type ConversationChat = Readonly<{ workspaceId: WorkspaceId; type: 'channel' | 'runtime' }>

const assertChangeable = (message: Message, memberId: MemberId) => {
  if (message.authorId !== memberId) throw new NotMessageAuthor()
  if (message.deletedAt) throw new MessageDeleted()
}

export const editedMessage = (message: Message, editorId: MemberId, body: MessageBody, at: Date): Message => {
  assertChangeable(message, editorId)
  return { ...message, body, editedAt: at }
}

export const deletedMessage = (message: Message, deleterId: MemberId, at: Date): Message => {
  assertChangeable(message, deleterId)
  return { ...message, deletedAt: at }
}

export const newMessage = (
  fields: Pick<Message, 'id' | 'workspaceId' | 'chatId' | 'kind' | 'authorId' | 'body' | 'createdAt' | 'replyToId'>,
): Message => ({ ...fields, detail: null, editedAt: null, deletedAt: null })
