import {
  type AiProviderAllowList,
  type ChatId,
  type ChatPermission,
  type ChatVisibility,
  type ConnectionTool,
  type CredentialId,
  type DevLoopSettings,
  grantedToolsOf,
  type HarnessId,
  type MemberId,
  type MessageId,
  type ProjectId,
  permissionsOf,
  type RuntimeHostId,
  type RuntimeId,
  type SetupCommand,
  type ToolApprovalPreference,
  type ToolServerAccess,
  type WorkspaceId,
  type WorkspacePermission,
} from '@spyria/kernel'

type WorkspaceRow = {
  id: WorkspaceId
  name: string
  localSessions: boolean
  aiProviderAllowList: AiProviderAllowList | null
  devLoop: DevLoopSettings | null
  setupCommands: readonly SetupCommand[]
}
type MembershipRow = {
  memberId: MemberId
  workspaceId: WorkspaceId
  displayName: string
  avatar: string | null
  email: string
  role: string
  removedAt: string | null
}
type InvitationRow = {
  workspaceId: WorkspaceId
  id: string
  email: string
  role: string
  expiresAt: number
}
export type RuntimeHostCapacity = {
  cpus: number
  memoryBytes: number
  dockerVersion: string
  rootless: boolean
  cgroupDriver: string
  limitsEnforced: boolean
  cap: number
  memoryFreeBytes?: number
  personal?: boolean
  signedIn?: string[]
}
export type RuntimeHostRow = {
  workspaceId: WorkspaceId
  id: RuntimeHostId
  name: string
  status: 'waiting' | 'online' | 'offline' | 'expired'
  claimExpiresAt: number | null
  capacity: RuntimeHostCapacity | null
  runningRuntimes: number
  hostVersion: string | null
  protocolVersion: number
  ownerId: MemberId | null
}
export type MachineCountsRow = { workspaceId: WorkspaceId; machines: number; claudeCode: number; codex: number }
export type RuntimeState =
  | 'creating'
  | 'installing'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'starting'
  | 'removing'
  | 'removed'
  | 'failed'
export type WarmRuntimeState = 'creating' | 'preparing' | 'ready' | 'failed'
export type RuntimeFailure =
  | 'no_host'
  | 'no_capacity'
  | 'no_image'
  | 'create_failed'
  | 'start_failed'
  | 'lost'
  | 'outdated'
  | `install_failed: ${string}`
type RuntimeRow = {
  workspaceId: WorkspaceId
  id: RuntimeId
  chatId: ChatId
  hostId: RuntimeHostId | null
  state: RuntimeState
  failure: RuntimeFailure | null
  hostOnline: boolean
}
type ProjectRow = { id: ProjectId; workspaceId: WorkspaceId; name: string; archived: boolean }
export type ChatRow = {
  id: ChatId
  workspaceId: WorkspaceId
  projectId: ProjectId | null
  type: 'channel' | 'runtime'
  visibility: ChatVisibility
  name: string
  ownerId: MemberId
  archived: boolean
  model: string | null
  reasoningEffort: string | null
  subagentPolicy: 'auto' | 'same_as_main'
  harness: HarnessId | null
  localSession: boolean | null
  gitBranch: string | null
  repository: string | null
  baseBranch: string | null
  originChatId: ChatId | null
  agentTurnMessageId: MessageId | null
  contextTokens: number | null
  contextWindow: number | null
  toolServersOff: readonly string[]
}
export type MessageRow = {
  id: MessageId
  workspaceId: WorkspaceId
  chatId: ChatId
  seq: number
  kind: 'member' | 'agent' | 'step' | 'notice'
  authorId: MemberId | null
  body: string
  attachments: readonly MessageAttachment[]
  step: MessageStep | null
  replyToId: MessageId | null
  threadRootId: MessageId | null
  quotedMessageId: MessageId | null
  createdAt: string
  editedAt: string | null
  deletedAt: string | null
  needsReply: boolean
}
export type DraftRow = { workspaceId: WorkspaceId; chatId: ChatId; memberId: MemberId; text: string }
type ReadMarkerRow = { workspaceId: WorkspaceId; memberId: MemberId; chatId: ChatId; lastReadSeq: number }
type ThreadReadMarkerRow = ReadMarkerRow & { threadRootId: MessageId }
export type RuntimeOriginRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  runtimeChatId: ChatId
  messageId: MessageId
  startedBy: MemberId
}
export type MessageStep = { readonly type: string; readonly [field: string]: unknown }
export type MessageAttachment = Readonly<{ id: string; name: string; mediaType: string; size: number }>
export type BrowserPageRow = { workspaceId: WorkspaceId; chatId: ChatId; url: string; title: string; openedAt: string }
type UsageEntryRow = {
  workspaceId: WorkspaceId
  month: string
  chatId: ChatId
  memberId: MemberId
  model: string
  tokens: number
  costMicros: number
  calls: number
}
type BudgetAlertRow = {
  workspaceId: WorkspaceId
  id: string
  memberId: MemberId | null
  month: string
  threshold: number
}
type SourceRow = { workspaceId: WorkspaceId; chatId: ChatId; name: string; origin: string }
type ToolConnectionRow = {
  workspaceId: WorkspaceId
  memberId: MemberId
  connectionId: string
  status: string
}
type LlmCredentialRow = {
  id: CredentialId
  workspaceId: WorkspaceId
  memberId: MemberId
  provider: string
  last4: string
}
type GitHubAppRow = { workspaceId: WorkspaceId }
type GitHubConnectionRow = { workspaceId: WorkspaceId; memberId: MemberId }
type WorkspaceOnboardingRow = { workspaceId: WorkspaceId; task: string }
type MemberOnboardingRow = {
  workspaceId: WorkspaceId
  memberId: MemberId
  task: string
  isCompleted: boolean
  isSkipped: boolean
}
export type ConnectionSignIn = 'member' | 'shared'
export type { AccessLevel, ToolApproval } from '@spyria/kernel'

type WorkspaceConnectionRow = {
  workspaceId: WorkspaceId
  id: string
  name: string
  gatewayName: string
  url: string
  signIn: ConnectionSignIn
  setupId: string | null
  headerName: string | null
  tools: readonly ConnectionTool[]
  isReviewed: boolean
  codeMode: boolean
}
type ConnectionAccessRow = ToolServerAccess & { workspaceId: WorkspaceId; id: string }
type ToolApprovalRow = ToolApprovalPreference & { workspaceId: WorkspaceId; memberId: MemberId }
type ChatMemberRow = {
  workspaceId: WorkspaceId
  chatId: ChatId
  memberId: MemberId
  roleId: string
}
type ChatRoleRow = {
  workspaceId: WorkspaceId
  id: string
  name: string
  permissions: readonly ChatPermission[]
  builtIn: boolean
}
type WorkspaceRoleRow = {
  workspaceId: WorkspaceId
  id: string
  name: string
  permissions: readonly WorkspacePermission[]
  builtIn: boolean
}

export type Snapshot = {
  workspaces: readonly WorkspaceRow[]
  memberships: readonly MembershipRow[]
  workspaceRoles: readonly WorkspaceRoleRow[]
  invitations: readonly InvitationRow[]
  projects: readonly ProjectRow[]
  chats: readonly ChatRow[]
  messages: readonly MessageRow[]
  latestMessages: readonly MessageRow[]
  latestAgentActivity: readonly MessageRow[]
  pinnedSteps: readonly MessageRow[]
  readMarkers: readonly ReadMarkerRow[]
  threadReadMarkers: readonly ThreadReadMarkerRow[]
  runtimeOrigins: readonly RuntimeOriginRow[]
  browserPages: readonly BrowserPageRow[]
  usageEntries: readonly UsageEntryRow[]
  budgetAlerts: readonly BudgetAlertRow[]
  sources: readonly SourceRow[]
  toolConnections: readonly ToolConnectionRow[]
  chatMembers: readonly ChatMemberRow[]
  chatRoles: readonly ChatRoleRow[]
  llmCredentials: readonly LlmCredentialRow[]
  githubApps: readonly GitHubAppRow[]
  githubConnections: readonly GitHubConnectionRow[]
  workspaceOnboarding: readonly WorkspaceOnboardingRow[]
  memberOnboarding: readonly MemberOnboardingRow[]
  workspaceConnections: readonly WorkspaceConnectionRow[]
  connectionAccess: readonly ConnectionAccessRow[]
  toolApprovals: readonly ToolApprovalRow[]
  runtimeHosts: readonly RuntimeHostRow[]
  machineCounts: readonly MachineCountsRow[]
  runtimes: readonly RuntimeRow[]
}

type ChatScoped = { workspaceId: WorkspaceId; chatId: ChatId }

export const chatIn = (snapshot: Snapshot, workspaceId: WorkspaceId, chatId: ChatId) =>
  snapshot.chats.find((chat) => chat.id === chatId && chat.workspaceId === workspaceId)

export const inChat = (workspaceId: WorkspaceId, chatId: ChatId) => (row: ChatScoped) =>
  row.workspaceId === workspaceId && row.chatId === chatId

export const ownedBy =
  (workspaceId: WorkspaceId, memberId: MemberId) => (row: { workspaceId: WorkspaceId; memberId: MemberId }) =>
    row.workspaceId === workspaceId && row.memberId === memberId

export const workspaceConnectionsIn = (snapshot: Snapshot, workspaceId: WorkspaceId) =>
  snapshot.workspaceConnections.filter((connection) => connection.workspaceId === workspaceId)

export const connectionAccessIn = (snapshot: Snapshot, workspaceId: WorkspaceId) =>
  snapshot.connectionAccess.filter((access) => access.workspaceId === workspaceId)

export const usableConnectionsIn = (snapshot: Snapshot, workspaceId: WorkspaceId, memberId: MemberId) => {
  const membership = snapshot.memberships.find(
    (row) => row.workspaceId === workspaceId && row.memberId === memberId && row.removedAt === null,
  )
  if (!membership) return []
  const accessRows = connectionAccessIn(snapshot, workspaceId)
  return workspaceConnectionsIn(snapshot, workspaceId).flatMap((connection) => {
    const granted = grantedToolsOf(connection, accessRows, { memberId, roleId: membership.role })
    if (granted.length === 0) return []
    const signedIn = snapshot.toolConnections.find(
      (row) => ownedBy(workspaceId, memberId)(row) && row.connectionId === connection.id,
    )
    const approvals = snapshot.toolApprovals.find(
      (row) => ownedBy(workspaceId, memberId)(row) && row.connectionId === connection.id,
    )
    return [
      {
        id: connection.id,
        name: connection.name,
        gatewayName: connection.gatewayName,
        signIn: connection.signIn,
        tools: connection.tools.filter((tool) => granted.includes(tool.name)),
        approvals,
        status: signedIn?.status,
      },
    ]
  })
}

export const memberNamesIn = (snapshot: Snapshot, workspaceId: WorkspaceId) => {
  const nameByMemberId = new Map(
    snapshot.memberships
      .filter((membership) => membership.workspaceId === workspaceId)
      .map((membership) => [membership.memberId, membership.displayName]),
  )
  return (memberId: MemberId) => nameByMemberId.get(memberId) ?? 'Unknown'
}

const participantIndexBySnapshot = new WeakMap<
  Snapshot,
  { participantsByChat: Map<string, ChatMemberRow[]>; roleById: Map<string, ChatRoleRow> }
>()

const participantIndexOf = (snapshot: Snapshot) => {
  const cached = participantIndexBySnapshot.get(snapshot)
  if (cached) return cached
  const index = {
    participantsByChat: Map.groupBy(snapshot.chatMembers, (row) => `${row.workspaceId}/${row.chatId}`),
    roleById: new Map(snapshot.chatRoles.map((role) => [`${role.workspaceId}/${role.id}`, role])),
  }
  participantIndexBySnapshot.set(snapshot, index)
  return index
}

export const chatParticipantsIn = (
  snapshot: Snapshot,
  workspaceId: WorkspaceId,
  chatId: ChatId,
): readonly ChatMemberRow[] => participantIndexOf(snapshot).participantsByChat.get(`${workspaceId}/${chatId}`) ?? []

export const participantIn = (snapshot: Snapshot, workspaceId: WorkspaceId, memberId: MemberId) => (chat: ChatRow) =>
  chatParticipantsIn(snapshot, workspaceId, chat.id).find((row) => row.memberId === memberId)

export const chatPermissionsIn =
  (snapshot: Snapshot, workspaceId: WorkspaceId, memberId: MemberId) => (chat: ChatRow) => {
    const participant = participantIn(snapshot, workspaceId, memberId)(chat)
    return permissionsOf(
      chat,
      participant && participantIndexOf(snapshot).roleById.get(`${workspaceId}/${participant.roleId}`),
    )
  }

export const workspacePermissionsIn = (snapshot: Snapshot, workspaceId: WorkspaceId, memberId: MemberId) => {
  const membership = snapshot.memberships.find(
    (row) => row.workspaceId === workspaceId && row.memberId === memberId && row.removedAt === null,
  )
  return (
    snapshot.workspaceRoles.find((role) => role.workspaceId === workspaceId && role.id === membership?.role)
      ?.permissions ?? []
  )
}
