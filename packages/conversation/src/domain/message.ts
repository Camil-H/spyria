import type { ChatId, ChatVisibility, HarnessId, MemberId, MessageId, WorkspaceId } from '@spyria/kernel'
import type { StoredStep } from './agent-steps.ts'
import type { Attachment } from './attachments.ts'
import {
  ChatFrozen,
  InvalidQuotedMessage,
  InvalidThreadRoot,
  MessageDeleted,
  NoThreadsInRuntimeChat,
  NotMessageAuthor,
} from './errors.ts'
import type { MessageBody } from './message-body.ts'

type MessageFields = Readonly<{
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
  replyToId: MessageId | null
  threadRootId: MessageId | null
  quotedMessageId: MessageId | null
}>

export type LiveMessage = MessageFields & Readonly<{ status: 'live' }>
export type DeletedMessage = MessageFields & Readonly<{ status: 'deleted'; deletedAt: Date }>
export type Message = LiveMessage | DeletedMessage

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

export const showsConversation = (chat: Readonly<{ archived: boolean }>) => !chat.archived

export const requireNotFrozen = (chat: Pick<ConversationChat, 'type' | 'isOwnerRemoved'>) => {
  if (isFrozen(chat)) throw new ChatFrozen()
}

const changeableBy = (message: Message, memberId: MemberId): LiveMessage => {
  if (message.authorId !== memberId) throw new NotMessageAuthor()
  if (message.status === 'deleted') throw new MessageDeleted()
  return message
}

export const editedMessage = (message: Message, editorId: MemberId, body: MessageBody, at: Date): LiveMessage => ({
  ...changeableBy(message, editorId),
  body,
  editedAt: at,
})

export const deletedMessage = (message: Message, deleterId: MemberId, at: Date): DeletedMessage => ({
  ...changeableBy(message, deleterId),
  status: 'deleted',
  attachments: [],
  deletedAt: at,
})

export const threadRootOf = (chat: ConversationChat, chatId: ChatId, root: Message | undefined) => {
  if (chat.type !== 'channel') throw new NoThreadsInRuntimeChat()
  if (!root || root.chatId !== chatId || root.threadRootId !== null || root.status === 'deleted')
    throw new InvalidThreadRoot()
  return root.id
}

export const quotableKinds: readonly Message['kind'][] = ['member', 'agent']

export const quotedMessageOf = (chatId: ChatId, quoted: Message | undefined) => {
  if (!quoted || quoted.chatId !== chatId || quoted.status === 'deleted' || !quotableKinds.includes(quoted.kind))
    throw new InvalidQuotedMessage()
  return quoted.id
}

export const newMessage = (
  fields: Pick<
    MessageFields,
    'id' | 'workspaceId' | 'chatId' | 'kind' | 'authorId' | 'body' | 'createdAt' | 'replyToId'
  > &
    Partial<Pick<MessageFields, 'step' | 'threadRootId' | 'quotedMessageId' | 'attachments'>>,
): LiveMessage => ({
  step: null,
  threadRootId: null,
  quotedMessageId: null,
  attachments: [],
  ...fields,
  detail: null,
  editedAt: null,
  status: 'live',
})
