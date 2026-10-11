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
  defaultModel: string | null
  gitBranch: string | null
  originChatId: ChatId | null
  harness?: 'claude-code' | 'codex' | null
  localSession?: boolean
}>
export type ChatKind = Chat['type'] | 'local_session'

export type ChatChange = Readonly<{
  type: 'chat.created' | 'chat.renamed' | 'chat.moved' | 'chat.archived'
  chat: Chat
  actorId: MemberId
}>

export const sessionFieldsOf = (kind: ChatKind) =>
  kind === 'local_session'
    ? ({ type: 'runtime', harness: 'claude-code', localSession: true } as const)
    : ({ type: kind, harness: null, localSession: false } as const)

export const movedChat = (chat: Chat, project: { id: ProjectId; workspaceId: WorkspaceId } | null): Chat => {
  if (project && project.workspaceId !== chat.workspaceId) throw new CrossWorkspaceMove()
  return { ...chat, projectId: project?.id ?? null }
}

export const archivedChat = (chat: Chat): Chat => ({ ...chat, archived: true })

export const renamedChat = (chat: Chat, name: Name): Chat => ({ ...chat, name })

export const startRuntimeChat = (
  source: Chat,
  fields: { id: ChatId; name: Name; ownerId: MemberId; defaultModel: string | null },
): Chat => {
  if (source.archived) throw new SourceChatArchived()
  return {
    ...fields,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    type: 'runtime',
    model: null,
    reasoningEffort: null,
    gitBranch: null,
    originChatId: source.id,
    archived: false,
  }
}
