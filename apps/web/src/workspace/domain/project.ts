import type { ProjectId, WorkspaceId } from '@hq/kernel'
import { type Chat, moveChat } from './chat.ts'
import type { Name } from './name.ts'

export type Project = Readonly<{ id: ProjectId; workspaceId: WorkspaceId; name: Name; archived: boolean }>

export type ChatsPolicy = 'archive' | 'release'

export const renameProject = (project: Project, name: Name): Project => ({ ...project, name })

export const archiveProject = (project: Project, chats: readonly Chat[], chatsPolicy: ChatsPolicy) => ({
  project: { ...project, archived: true },
  chats: chats.map((chat) => (chatsPolicy === 'archive' ? { ...chat, archived: true } : moveChat(chat, null))),
})
