import type { ChatId, MemberId, MessageId, ProjectId, WorkspaceId } from '@hq/kernel'

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
  model: string | null
  originChatId: ChatId | null
}
export type MessageRow = {
  id: MessageId
  workspaceId: WorkspaceId
  chatId: ChatId
  kind: 'member' | 'agent' | 'tool-call'
  authorId: MemberId | null
  body: string
  detail: string | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  needsReply: boolean
}
export type DraftRow = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }

export type Snapshot = {
  workspaces: readonly WorkspaceRow[]
  members: readonly MemberRow[]
  memberships: readonly MembershipRow[]
  projects: readonly ProjectRow[]
  chats: readonly ChatRow[]
  messages: readonly MessageRow[]
  drafts: readonly DraftRow[]
}
