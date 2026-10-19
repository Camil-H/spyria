import { type ChatRow, chatPermissionsIn, participantIn, type Snapshot } from '@spyria/db'
import { type ChatId, can, type MemberId, type ProjectId, type WorkspaceId } from '@spyria/kernel'

type ChatSummaryRow = Readonly<{
  id: ChatId
  name: string
  type: ChatRow['type']
  visibility: ChatRow['visibility']
  canAdmin: boolean
  canLeave: boolean
}>
export type Sidebar = Readonly<{
  projects: readonly Readonly<{ id: ProjectId; name: string; chats: readonly ChatSummaryRow[] }>[]
  looseChats: readonly ChatSummaryRow[]
}>

export const getSidebar =
  (workspaceId: WorkspaceId, viewerId: MemberId) =>
  (snapshot: Snapshot): Sidebar => {
    const permissionsOf = chatPermissionsIn(snapshot, workspaceId, viewerId)
    const isParticipant = participantIn(snapshot, workspaceId, viewerId)
    const chatsByProjectId = new Map<ProjectId | null, ChatSummaryRow[]>()
    for (const chat of snapshot.chats) {
      if (chat.workspaceId !== workspaceId || chat.archived || !isParticipant(chat)) continue
      const projectChats = chatsByProjectId.get(chat.projectId) ?? []
      projectChats.push({
        id: chat.id,
        name: chat.name,
        type: chat.type,
        visibility: chat.visibility,
        canAdmin: can(permissionsOf(chat), 'chat.admin'),
        canLeave: chat.ownerId !== viewerId,
      })
      chatsByProjectId.set(chat.projectId, projectChats)
    }
    return {
      projects: snapshot.projects
        .filter((project) => project.workspaceId === workspaceId && !project.archived)
        .map(({ id, name }) => ({ id, name, chats: chatsByProjectId.get(id) ?? [] })),
      looseChats: chatsByProjectId.get(null) ?? [],
    }
  }
