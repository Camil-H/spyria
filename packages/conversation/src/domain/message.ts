import type { ChatId, ChatVisibility, HarnessId, MemberId, MessageId, WorkspaceId } from '@spyria/kernel'
import type { StoredStep } from './agent-steps.ts'
import type { Attachment } from './attachments.ts'
import { ChatFrozen, InvalidThreadRoot, MessageDeleted, NoThreadsInRuntimeChat, NotMessageAuthor } from './errors.ts'
import type { MessageBody } from './message-body.ts'

export type Message = Readonly<{
  id: MessageId
  workspaceId: WorkspaceId
  chatId: ChatId
  kind: 'member' | 'agent' | 'step' | 'notice'
  authorId: MemberId | null
  body: MessageBody
  attachments: readonly Attachment[]
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
  harness: HarnessId | null
  ownerId: MemberId | null
  localSession: boolean | null
  baseBranch: string | null
  isOwnerRemoved: boolean
}>

export const agentActivityKinds: readonly Message['kind'][] = ['agent', 'step']
export const isAgentActivity = (message: Pick<Message, 'kind' | 'authorId'>) =>
  agentActivityKinds.includes(message.kind) && message.authorId === null

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
  return { ...message, attachments: [], deletedAt: at }
}

export const threadRootOf = (chat: ConversationChat, chatId: ChatId, root: Message | undefined) => {
  if (chat.type !== 'channel') throw new NoThreadsInRuntimeChat()
  if (!root || root.chatId !== chatId || root.threadRootId !== null || root.deletedAt) throw new InvalidThreadRoot()
  return root.id
}

export const newMessage = (
  fields: Pick<Message, 'id' | 'workspaceId' | 'chatId' | 'kind' | 'authorId' | 'body' | 'createdAt' | 'replyToId'> &
    Partial<Pick<Message, 'step' | 'threadRootId' | 'attachments'>>,
): Message => ({
  step: null,
  threadRootId: null,
  attachments: [],
  ...fields,
  detail: null,
  editedAt: null,
  deletedAt: null,
})
