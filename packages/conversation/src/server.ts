export type { Clock } from './contracts/clock.ts'
export type {
  ChatRepository,
  Draft,
  DraftRepository,
  MessageRepository,
  ReadMarkerRepository,
} from './contracts/repositories.ts'
export type { RuntimeChatStarter } from './contracts/runtime-chat-starter.ts'
export type { ConversationTransactor, UnitOfWork } from './contracts/transactor.ts'
export {
  BlankMessageBody,
  ChatNotFound,
  ConversationError,
  MessageDeleted,
  MessageNotFound,
  NotMessageAuthor,
} from './domain/errors.ts'
export type { ConversationChat, Message } from './domain/message.ts'
export type { MessageBody } from './domain/message-body.ts'
export type { ReadMarker } from './domain/read-marker.ts'
export { createStoreTransactor } from './integrations/store-transactor.ts'
export { createSystemClock } from './integrations/system-clock.ts'
export { createWorkspaceRuntimeChatStarter } from './integrations/workspace-runtime-chat-starter.ts'
export { appendAgentReply } from './operations/append-agent-reply.ts'
export { deleteMessage } from './operations/delete-message.ts'
export { editMessage } from './operations/edit-message.ts'
export { markChatRead } from './operations/mark-chat-read.ts'
export { saveDraft } from './operations/save-draft.ts'
export { sendMessage } from './operations/send-message.ts'
export { startRuntimeFromMessage } from './operations/start-runtime-from-message.ts'
export { type Conversation, type ConversationMessage, getConversation } from './queries/get-conversation.ts'
export { getDraft } from './queries/get-draft.ts'
export { hasDraft } from './queries/has-draft.ts'
export { hasUnread } from './queries/has-unread.ts'
