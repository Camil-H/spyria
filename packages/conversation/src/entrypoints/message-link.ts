import type { ChatId, MessageId, WorkspaceId } from '@spyria/kernel'

export const linkedMessageParam = 'message'

export const messageLinkOf = (origin: string, workspaceId: WorkspaceId, chatId: ChatId, messageId: MessageId) =>
  `${origin}/w/${encodeURIComponent(workspaceId)}/chats/${encodeURIComponent(chatId)}?${new URLSearchParams({ [linkedMessageParam]: messageId })}`
