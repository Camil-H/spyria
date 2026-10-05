import type { ChatRow, Snapshot } from '@hq/db'
import type { ChatId, ProjectId, WorkspaceId } from '@hq/kernel'

type ChatSummaryRow = Readonly<{ id: ChatId; name: string; type: ChatRow['type'] }>
export type Sidebar = Readonly<{
  projects: readonly Readonly<{ id: ProjectId; name: string; chats: readonly ChatSummaryRow[] }>[]
  looseChats: readonly ChatSummaryRow[]
}>

export const getSidebar =
  (workspaceId: WorkspaceId) =>
  (snapshot: Snapshot): Sidebar => {
    const chatsByProjectId = new Map<ProjectId | null, ChatSummaryRow[]>()
    for (const chat of snapshot.chats) {
      if (chat.workspaceId !== workspaceId || chat.archived) continue
      const projectChats = chatsByProjectId.get(chat.projectId) ?? []
      projectChats.push({ id: chat.id, name: chat.name, type: chat.type })
      chatsByProjectId.set(chat.projectId, projectChats)
    }
    return {
      projects: snapshot.projects
        .filter((project) => project.workspaceId === workspaceId && !project.archived)
        .map(({ id, name }) => ({ id, name, chats: chatsByProjectId.get(id) ?? [] })),
      looseChats: chatsByProjectId.get(null) ?? [],
    }
  }
