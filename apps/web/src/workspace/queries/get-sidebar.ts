import type { ChatRow, Snapshot } from '@hq/db'
import type { ChatId, ProjectId, WorkspaceId } from '@hq/kernel'

type ChatSummaryRow = Readonly<{ id: ChatId; name: string; type: ChatRow['type']; ownerName: string }>
export type Sidebar = Readonly<{
  projects: readonly Readonly<{ id: ProjectId; name: string; chats: readonly ChatSummaryRow[] }>[]
  looseChats: readonly ChatSummaryRow[]
}>

export const getSidebar =
  (workspaceId: WorkspaceId) =>
  (snapshot: Snapshot): Sidebar => {
    const ownerNames = new Map(snapshot.members.map((member) => [member.id, member.name]))
    const chatsByProjectId = new Map<ProjectId | null, ChatSummaryRow[]>()
    for (const chat of snapshot.chats) {
      if (chat.workspaceId !== workspaceId || chat.archived) continue
      const ownerName = ownerNames.get(chat.ownerId)
      if (ownerName === undefined) throw new Error(`Chat ${chat.id} owner ${chat.ownerId} is not a known member`)
      const row = { id: chat.id, name: chat.name, type: chat.type, ownerName }
      chatsByProjectId.set(chat.projectId, [...(chatsByProjectId.get(chat.projectId) ?? []), row])
    }
    return {
      projects: snapshot.projects
        .filter((project) => project.workspaceId === workspaceId && !project.archived)
        .map(({ id, name }) => ({ id, name, chats: chatsByProjectId.get(id) ?? [] })),
      looseChats: chatsByProjectId.get(null) ?? [],
    }
  }
