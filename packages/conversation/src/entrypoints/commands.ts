import type { WorkspaceId } from '@hq/kernel'
import { deleteMessage } from '../operations/delete-message.ts'
import { editMessage } from '../operations/edit-message.ts'
import { markChatRead } from '../operations/mark-chat-read.ts'
import { saveDraft } from '../operations/save-draft.ts'
import { sendMessage } from '../operations/send-message.ts'
import { startRuntimeFromMessage } from '../operations/start-runtime-from-message.ts'

export const conversationOperations = {
  deleteMessage,
  editMessage,
  markChatRead,
  saveDraft,
  sendMessage,
  startRuntimeFromMessage,
}

type ConversationOperations = typeof conversationOperations

export type ConversationCommands = {
  [Name in keyof ConversationOperations]: (
    input: Parameters<ConversationOperations[Name]>[1] & { workspaceId: WorkspaceId },
  ) => ReturnType<ConversationOperations[Name]>
}
