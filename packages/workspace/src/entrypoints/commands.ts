import type { ChatId, ProjectId, WorkspaceId } from '@hq/kernel'
import type { Chat } from '../domain/chat.ts'
import type { Name } from '../domain/name.ts'
import type { ChatsPolicy } from '../domain/project.ts'

type Command<Input> = (input: Input & { workspaceId: WorkspaceId }) => Promise<string>

export type WorkspaceCommands = {
  createProject: Command<{ name: Name }>
  createChat: Command<{ type: Chat['type']; name: Name; projectId: ProjectId | null }>
  moveChat: Command<{ chatId: ChatId; projectId: ProjectId | null }>
  archiveChat: Command<{ chatId: ChatId }>
  archiveProject: Command<{ projectId: ProjectId; chatsPolicy: ChatsPolicy }>
  renameChat: Command<{ chatId: ChatId; name: Name }>
  renameProject: Command<{ projectId: ProjectId; name: Name }>
  createWorkspace: Command<{ name: Name }>
}
