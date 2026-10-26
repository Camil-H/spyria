import type { ChatId, ChatVisibility, MemberId, ProjectId, WorkspaceId } from '@spyria/kernel'
import { CrossWorkspaceMove, RuntimeChatPrivate, SourceChatArchived } from './errors.ts'
import { workingBranchOf } from './github.ts'
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
  mode: 'dev' | 'non-dev' | null
  gitBranch: string | null
  repository: string | null
  baseBranch: string | null
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

type StartedChatFields = { id: ChatId; name: Name; ownerId: MemberId }

const continuedDevFieldsOf = (source: Chat, { id, name, ownerId }: StartedChatFields) =>
  source.mode === 'dev'
    ? {
        mode: source.mode,
        repository: source.repository,
        baseBranch: source.baseBranch,
        gitBranch: source.ownerId === ownerId ? source.gitBranch : workingBranchOf(name, id),
      }
    : { mode: null, gitBranch: null, repository: null, baseBranch: null }

export const startRuntimeChat = (source: Chat, fields: StartedChatFields): Chat => {
  if (source.archived) throw new SourceChatArchived()
  return {
    ...fields,
    workspaceId: source.workspaceId,
    projectId: source.projectId,
    type: 'runtime',
    visibility: 'private',
    model: null,
    reasoningEffort: null,
    ...continuedDevFieldsOf(source, fields),
    originChatId: source.id,
    archived: false,
  }
}

export const devChat = (chat: Chat, repository: string, baseBranch: string): Chat => ({
  ...chat,
  mode: 'dev',
  repository,
  baseBranch,
  gitBranch: workingBranchOf(chat.name, chat.id),
})
