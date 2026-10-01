import type { ChatId, MemberId, ProjectId, WorkspaceId } from '@hq/kernel'
import { CrossWorkspaceMove } from './errors.ts'
import type { Name } from './name.ts'

export type Chat = Readonly<{
  id: ChatId
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  type: 'channel' | 'runtime'
  name: Name
  ownerId: MemberId
  archived: boolean
}>

export const moveChat = (chat: Chat, project: { id: ProjectId; workspaceId: WorkspaceId } | null): Chat => {
  if (project && project.workspaceId !== chat.workspaceId) throw new CrossWorkspaceMove()
  return { ...chat, projectId: project?.id ?? null }
}
