import type { ChatId, MemberId, ProjectId, WorkspaceId } from '@hq/kernel'
import { CrossWorkspaceMove, SourceChatArchived } from './errors.ts'
import type { Name } from './name.ts'

export type Chat = Readonly<{
  id: ChatId
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  type: 'channel' | 'runtime'
  name: Name
  ownerId: MemberId
  archived: boolean
  model: string | null
  reasoningEffort: string | null
  gitBranch: string | null
  originChatId: ChatId | null
}>

export const moveChat = (chat: Chat, project: { id: ProjectId; workspaceId: WorkspaceId } | null): Chat => {
  if (project && project.workspaceId !== chat.workspaceId) throw new CrossWorkspaceMove()
  return { ...chat, projectId: project?.id ?? null }
}

export const archiveChat = (chat: Chat): Chat => ({ ...chat, archived: true })

export const renameChat = (chat: Chat, name: Name): Chat => ({ ...chat, name })

export const startRuntimeChat = (
  source: Chat,
  fields: { id: ChatId; name: Name; ownerId: MemberId; model: string; reasoningEffort: string },
): Chat => {
  if (source.archived) throw new SourceChatArchived()
  return {
    ...fields,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    type: 'runtime',
    gitBranch: null,
    originChatId: source.id,
    archived: false,
  }
}
