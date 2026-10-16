import { DomainError, errorKind } from '@hq/kernel'

export class ConversationError extends DomainError {}

export const BlankMessageBody = errorKind(
  'blank_message_body',
  () => 'A message must contain at least one non-blank character',
  ConversationError,
)
export const NotMessageAuthor = errorKind(
  'not_message_author',
  () => 'Only the author can change a message',
  ConversationError,
)
export const MessageDeleted = errorKind(
  'message_deleted',
  () => 'A deleted message cannot be changed',
  ConversationError,
)
export const MessageNotFound = errorKind(
  'message_not_found',
  (messageId: string) => `Message ${messageId} was not found`,
  ConversationError,
)
export const ChatNotFound = errorKind(
  'chat_not_found',
  (chatId: string) => `Chat ${chatId} was not found`,
  ConversationError,
)
export const NoLlmKey = errorKind('no_llm_key', (notice: string) => notice, ConversationError)
export const ForeignWorkspace = errorKind(
  'foreign_workspace',
  () => 'The change targets a workspace other than the current one',
  ConversationError,
)
export const InvalidRouting = errorKind('invalid_routing', (message: string) => message, ConversationError)
export const RunsOnNotChosen = errorKind('runs_on_not_chosen', (notice: string) => notice, ConversationError)
