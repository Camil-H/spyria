import type { ChatId, ChatVisibility, MemberId, ProjectId, WorkspaceId } from '@hq/kernel'
import { CrossWorkspaceMove, RuntimeChatPrivate, SourceChatArchived } from './errors.ts'
import type { Name } from './name.ts'

export type Chat = Readonly<{
  id: ChatId
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  type: 'channel' | 'runtime'
  visibility: ChatVisibility
  name: Name
  ownerId: MemberId
  archived: boolean
  model: string | null
  reasoningEffort: string | null
  gitBranch: string | null
  originChatId: ChatId | null
}>

export type ChatChange = Readonly<{
  type: 'chat.created' | 'chat.renamed' | 'chat.moved' | 'chat.archived' | 'chat.visibility_changed'
  chat: Chat
  actorId: MemberId
}>

export const movedChat = (chat: Chat, project: { id: ProjectId; workspaceId: WorkspaceId } | null): Chat => {
  if (project && project.workspaceId !== chat.workspaceId) throw new CrossWorkspaceMove()
  return { ...chat, projectId: project?.id ?? null }
}

export const archivedChat = (chat: Chat): Chat => ({ ...chat, archived: true })

export const renamedChat = (chat: Chat, name: Name): Chat => ({ ...chat, name })

export const visibleChat = (chat: Chat, visibility: ChatVisibility): Chat => {
  if (chat.type === 'runtime') throw new RuntimeChatPrivate()
  return { ...chat, visibility }
}

export const startRuntimeChat = (source: Chat, fields: { id: ChatId; name: Name; ownerId: MemberId }): Chat => {
  if (source.archived) throw new SourceChatArchived()
  return {
    ...fields,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    type: 'runtime',
    visibility: 'private',
    model: null,
    reasoningEffort: null,
    gitBranch: null,
    originChatId: source.id,
    archived: false,
  }
}
