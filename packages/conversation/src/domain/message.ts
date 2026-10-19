import type { ChatId, ChatVisibility, MemberId, MessageId, WorkspaceId } from '@spyria/kernel'
import type { StoredStep } from './agent-steps.ts'
import { ChatFrozen, InvalidThreadRoot, MessageDeleted, NoThreadsInRuntimeChat, NotMessageAuthor } from './errors.ts'
import type { MessageBody } from './message-body.ts'
import type { Harness } from './session-routing.ts'

export type Message = Readonly<{
  id: MessageId
  workspaceId: WorkspaceId
  chatId: ChatId
  kind: 'member' | 'agent' | 'step' | 'notice'
  authorId: MemberId | null
  body: MessageBody
  detail: string | null
  step: StoredStep | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
  replyToId: MessageId | null
  threadRootId: MessageId | null
}>

export type MessageChange = Readonly<{
  type: 'message.posted' | 'message.replied' | 'message.edited' | 'message.deleted' | 'message.step_changed'
  actorId: MemberId | null
  message: Message
}>

export type ConversationChat = Readonly<{
  workspaceId: WorkspaceId
  name: string
  type: 'channel' | 'runtime'
  visibility: ChatVisibility
  harness: Harness | null
  ownerId: MemberId | null
  localSession: boolean | null
  baseBranch: string | null
  isOwnerRemoved: boolean
}>

export const isFrozen = (chat: Pick<ConversationChat, 'type' | 'isOwnerRemoved'>) =>
  chat.type === 'runtime' && chat.isOwnerRemoved

export const requireNotFrozen = (chat: Pick<ConversationChat, 'type' | 'isOwnerRemoved'>) => {
  if (isFrozen(chat)) throw new ChatFrozen()
}

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

export const threadRootOf = (chat: ConversationChat, chatId: ChatId, root: Message | undefined) => {
  if (chat.type !== 'channel') throw new NoThreadsInRuntimeChat()
  if (!root || root.chatId !== chatId || root.threadRootId !== null || root.deletedAt) throw new InvalidThreadRoot()
  return root.id
}

export const newMessage = (
  fields: Pick<Message, 'id' | 'workspaceId' | 'chatId' | 'kind' | 'authorId' | 'body' | 'createdAt' | 'replyToId'> &
    Partial<Pick<Message, 'step' | 'threadRootId'>>,
): Message => ({ step: null, threadRootId: null, ...fields, detail: null, editedAt: null, deletedAt: null })
