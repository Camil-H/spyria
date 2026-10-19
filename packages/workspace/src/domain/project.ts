import type { ProjectId, WorkspaceId } from '@spyria/kernel'
import { type Chat, movedChat } from './chat.ts'
import type { Name } from './name.ts'

export type Project = Readonly<{ id: ProjectId; workspaceId: WorkspaceId; name: Name; archived: boolean }>

export type ChatsPolicy = 'archive' | 'release'

export const renamedProject = (project: Project, name: Name): Project => ({ ...project, name })

export const archivedProject = (project: Project, chats: readonly Chat[], chatsPolicy: ChatsPolicy) => ({
  project: { ...project, archived: true },
  chats: chats
    .filter((chat) => !chat.archived)
    .map((chat) => (chatsPolicy === 'archive' ? { ...chat, archived: true } : movedChat(chat, null))),
})
