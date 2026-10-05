import type {
  ChatId,
  CredentialId,
  MemberId,
  MessageId,
  ProjectId,
  RuntimeHostId,
  RuntimeId,
  WorkspaceId,
} from '@hq/kernel'

type WorkspaceRow = { id: WorkspaceId; name: string }
type MembershipRow = { memberId: MemberId; workspaceId: WorkspaceId; displayName: string; role: 'admin' | 'member' }
export type RuntimeHostCapacity = {
  cpus: number
  memoryBytes: number
  dockerVersion: string
  rootless: boolean
  cgroupDriver: string
  limitsEnforced: boolean
  cap: number
  memoryFreeBytes?: number
}
export type RuntimeHostRow = {
  workspaceId: WorkspaceId
  id: RuntimeHostId
  name: string
  status: 'waiting' | 'online' | 'offline' | 'expired'
  claimExpiresAt: number | null
  capacity: RuntimeHostCapacity | null
  runningRuntimes: number
}
export type RuntimeState =
  | 'creating'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'starting'
  | 'removing'
  | 'removed'
  | 'failed'
export type RuntimeFailure = 'no_host' | 'no_capacity' | 'create_failed' | 'start_failed' | 'lost'
type RuntimeRow = {
  workspaceId: WorkspaceId
  id: RuntimeId
  chatId: ChatId
  hostId: RuntimeHostId | null
  state: RuntimeState
  failure: RuntimeFailure | null
}
type ProjectRow = { id: ProjectId; workspaceId: WorkspaceId; name: string; archived: boolean }
export type ChatRow = {
  id: ChatId
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  type: 'channel' | 'runtime'
  name: string
  ownerId: MemberId
  archived: boolean
  model: string | null
  reasoningEffort: string | null
  gitBranch: string | null
  originChatId: ChatId | null
}
export type MessageRow = {
  id: MessageId
  workspaceId: WorkspaceId
  chatId: ChatId
  seq: number
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
type ReadMarkerRow = { workspaceId: WorkspaceId; memberId: MemberId; chatId: ChatId; lastReadSeq: number }
export type FileRow = { workspaceId: WorkspaceId; chatId: ChatId; path: string; kind: 'file' | 'folder' }
export type DiffLine = { kind: 'added' | 'removed' | 'context'; text: string }
export type ChangeRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  path: string
  additions: number
  deletions: number
  diffLines: readonly DiffLine[]
}
type TerminalLineRow = { workspaceId: WorkspaceId; chatId: ChatId; text: string }
type PlanStepRow = { workspaceId: WorkspaceId; chatId: ChatId; title: string; status: string }
type CommitRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  sha: string
  message: string
  authorId: MemberId
  committedAt: string
}
type BrowserPageRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  url: string
  title: string
  bodyText: string
}
type UsageEntryRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  memberId: MemberId
  tokens: number
  costCents: number
}
type SourceRow = { workspaceId: WorkspaceId; chatId: ChatId; name: string; origin: string }
type ToolConnectionRow = {
  workspaceId: WorkspaceId
  memberId: MemberId
  tool: string
  status: string
}
type LlmCredentialRow = {
  id: CredentialId
  workspaceId: WorkspaceId
  memberId: MemberId
  provider: string
  last4: string
}
type WorkspaceConnectionRow = {
  workspaceId: WorkspaceId
  memberId: MemberId
  tool: string
  access: string
}
type ChatMemberRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  memberId: MemberId
  role: string
}

export type Snapshot = {
  workspaces: readonly WorkspaceRow[]
  memberships: readonly MembershipRow[]
  projects: readonly ProjectRow[]
  chats: readonly ChatRow[]
  messages: readonly MessageRow[]
  drafts: readonly DraftRow[]
  readMarkers: readonly ReadMarkerRow[]
  files: readonly FileRow[]
  changes: readonly ChangeRow[]
  terminalLines: readonly TerminalLineRow[]
  planSteps: readonly PlanStepRow[]
  commits: readonly CommitRow[]
  browserPages: readonly BrowserPageRow[]
  usageEntries: readonly UsageEntryRow[]
  sources: readonly SourceRow[]
  toolConnections: readonly ToolConnectionRow[]
  chatMembers: readonly ChatMemberRow[]
  llmCredentials: readonly LlmCredentialRow[]
  workspaceConnections: readonly WorkspaceConnectionRow[]
  runtimeHosts: readonly RuntimeHostRow[]
  runtimes: readonly RuntimeRow[]
}

type ChatScoped = { workspaceId: WorkspaceId; chatId: ChatId }

export const findChat = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) =>
  snapshot.chats.find((chat) => chat.id === chatId && chat.workspaceId === workspaceId && !chat.archived)

export const inChat = (workspaceId: WorkspaceId, chatId: ChatId) => (row: ChatScoped) =>
  row.workspaceId === workspaceId && row.chatId === chatId

export const ownedBy =
  (workspaceId: WorkspaceId, memberId: MemberId) => (row: { workspaceId: WorkspaceId; memberId: MemberId }) =>
    row.workspaceId === workspaceId && row.memberId === memberId

export const memberNamesIn = (snapshot: Snapshot, workspaceId: WorkspaceId) => {
  const nameByMemberId = new Map(
    snapshot.memberships
      .filter((membership) => membership.workspaceId === workspaceId)
      .map((membership) => [membership.memberId, membership.displayName]),
  )
  return (memberId: MemberId) => nameByMemberId.get(memberId) ?? 'Unknown'
}

export const toolCatalog = ['GitHub', 'Slack', 'Notion', 'Linear']
