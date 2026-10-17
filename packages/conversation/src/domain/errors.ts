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
export const NoThreadsInRuntimeChat = errorKind(
  'no_threads_in_runtime_chat',
  () => 'A runtime chat has no threads',
  ConversationError,
)
export const InvalidThreadRoot = errorKind(
  'invalid_thread_root',
  () => 'A thread starts on a message of this chat that is not a reply and not deleted',
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
export const NotWorkspaceMember = errorKind(
  'not_workspace_member',
  () => 'Only members of this workspace can join a chat',
  ConversationError,
)
export const AlreadyParticipant = errorKind(
  'already_participant',
  () => 'This member is already in the chat',
  ConversationError,
)
export const NotParticipant = errorKind('not_participant', () => 'This member is not in the chat', ConversationError)
export const RoleNotFound = errorKind(
  'role_not_found',
  (roleId: string) => `Role ${roleId} was not found`,
  ConversationError,
)
export const RoleAboveOwn = errorKind(
  'role_above_own',
  () => 'You can only give a role within your own permissions',
  ConversationError,
)
export const OwnerRoleNotAssignable = errorKind(
  'owner_role_not_assignable',
  () => 'The Owner role cannot be given',
  ConversationError,
)
export const OwnerStays = errorKind(
  'owner_stays',
  () => 'The owner keeps the Owner role and stays in the chat',
  ConversationError,
)
