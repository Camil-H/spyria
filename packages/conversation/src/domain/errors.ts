import { blankKind, DomainError, errorKind } from '@spyria/kernel'

class ConversationError extends DomainError {}

export const BlankMessageBody = blankKind('blank_message_body', 'A message', ConversationError)
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
export const RuntimeOnlyFromChannel = errorKind(
  'runtime_only_from_channel',
  () => 'A runtime starts only from a channel message',
  ConversationError,
)
export const NotForkable = errorKind('not_forkable', () => 'Only runtime chats can be forked', ConversationError)
export const PublicChatOpenToAll = errorKind(
  'public_chat_open_to_all',
  () => 'Everyone can read and post in a public chat; make it private to restrict someone',
  ConversationError,
)
export const OwnerStays = errorKind(
  'owner_stays',
  () => 'The owner keeps the Owner role and stays in the chat',
  ConversationError,
)
export const ChatFrozen = errorKind(
  'chat_frozen',
  () => 'This chat is frozen: its owner left the workspace',
  ConversationError,
)
export const AttachmentNotAllowed = errorKind(
  'attachment_not_allowed',
  () => 'Attach an image, a sound, a video or a PDF of up to 20 MB',
  ConversationError,
)
export const AttachmentTooLarge = errorKind('attachment_too_large', () => 'The file is over 20 MB', ConversationError)
export const TooManyPendingUploads = errorKind(
  'too_many_pending_uploads',
  () => 'Send or remove the files you already attached before adding more',
  ConversationError,
)
export const AttachmentStorageFull = errorKind(
  'attachment_storage_full',
  () => 'This workspace has no room left for attachments: delete messages with large files to make room',
  ConversationError,
)
export const TooManyAttachments = errorKind(
  'too_many_attachments',
  (maximum: number) => `A message can carry up to ${maximum} attachments`,
  ConversationError,
)
export const RuntimeMediaUnavailable = errorKind(
  'runtime_media_unavailable',
  () => 'This file can be shown only while the runtime is running',
  ConversationError,
)
export const AttachmentNotFound = errorKind(
  'attachment_not_found',
  () => 'This attachment is no longer available',
  ConversationError,
)
