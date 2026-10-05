import type { ChatId, MessageId, WorkspaceId } from '@hq/kernel'

type Command<Input, Result = string> = (input: Input & { workspaceId: WorkspaceId }) => Promise<Result>

export type ConversationCommands = {
  sendMessage: Command<{ chatId: ChatId; text: string }>
  editMessage: Command<{ messageId: MessageId; text: string }>
  deleteMessage: Command<{ messageId: MessageId }>
  markChatRead: Command<{ chatId: ChatId }>
  startRuntimeFromMessage: Command<{ messageId: MessageId }>
  saveDraft: Command<{ chatId: ChatId; text: string }, void>
}
