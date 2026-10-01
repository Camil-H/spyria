import type { ChatId, MemberId, ProjectId, WorkspaceId } from '@hq/kernel'

type WorkspaceRow = { id: WorkspaceId; name: string }
type MemberRow = { id: MemberId; name: string }
type MembershipRow = { memberId: MemberId; workspaceId: WorkspaceId }
export type ProjectRow = { id: ProjectId; workspaceId: WorkspaceId; name: string; archived: boolean }
export type ChatRow = {
  id: ChatId
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  type: 'channel' | 'runtime'
  name: string
  ownerId: MemberId
  archived: boolean
}

export type Snapshot = {
  workspaces: readonly WorkspaceRow[]
  members: readonly MemberRow[]
  memberships: readonly MembershipRow[]
  projects: readonly ProjectRow[]
  chats: readonly ChatRow[]
}
