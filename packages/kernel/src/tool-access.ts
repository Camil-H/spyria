import type { MemberId } from './ids.ts'

export const accessLevels = { none: 'none', read: 'read', write: 'write' } as const
export type AccessLevel = (typeof accessLevels)[keyof typeof accessLevels]
export const toolApprovals = { never: 'never', always: 'always', guest: 'guest' } as const
export type ToolApproval = (typeof toolApprovals)[keyof typeof toolApprovals]

export type ConnectionTool = Readonly<{ name: string; readOnly: boolean; destructive: boolean }>
export type ToolServerAccess = Readonly<{
  connectionId: string
  roleId: string
  level: AccessLevel
  toolChanges: Readonly<Record<string, boolean>>
}>
export type ToolHolder = Readonly<{ memberId: MemberId; roleId: string }>
export type ToolApprovalPreference = Readonly<{
  connectionId: string
  serverApproval: ToolApproval | null
  toolApprovals: Readonly<Record<string, ToolApproval>>
}>
type GrantedServer = Readonly<{
  id: string
  signIn: 'member' | 'shared'
  setupId: string | null
  isReviewed: boolean
  tools: readonly ConnectionTool[]
}>

export const ownValueOf = <Value>(record: Readonly<Record<string, Value>> | undefined, key: string) =>
  record && Object.hasOwn(record, key) ? record[key] : undefined

export const isAllowedAtLevel = (level: AccessLevel, tool: ConnectionTool) =>
  level === accessLevels.write || (level === accessLevels.read && tool.readOnly)

export const holderAccessOf = (connectionId: string, accessRows: readonly ToolServerAccess[], { roleId }: ToolHolder) =>
  accessRows.find((access) => access.connectionId === connectionId && access.roleId === roleId)

export const toolsAllowedBy = (tools: readonly ConnectionTool[], access: ToolServerAccess | undefined) =>
  access
    ? tools.filter((tool) => ownValueOf(access.toolChanges, tool.name) ?? isAllowedAtLevel(access.level, tool))
    : []

export const grantedToolsOf = (server: GrantedServer, accessRows: readonly ToolServerAccess[], holder: ToolHolder) =>
  server.setupId === null && server.isReviewed
    ? toolsAllowedBy(server.tools, holderAccessOf(server.id, accessRows, holder)).map(({ name }) => name)
    : []

export const serverApprovalOf = (server: Pick<GrantedServer, 'signIn'>, preference?: ToolApprovalPreference) =>
  preference?.serverApproval ?? (server.signIn === 'shared' ? toolApprovals.guest : toolApprovals.never)

export const defaultToolApprovalOf = (
  server: Pick<GrantedServer, 'signIn'>,
  tool: ConnectionTool,
  preference?: ToolApprovalPreference,
) => {
  if (tool.destructive) return toolApprovals.always
  return tool.readOnly ? toolApprovals.never : serverApprovalOf(server, preference)
}

export const toolApprovalOf = (
  server: Pick<GrantedServer, 'signIn'>,
  tool: ConnectionTool,
  preference?: ToolApprovalPreference,
) => ownValueOf(preference?.toolApprovals, tool.name) ?? defaultToolApprovalOf(server, tool, preference)

export const approvalChoicesOf = (server: Pick<GrantedServer, 'signIn'>): readonly ToolApproval[] =>
  server.signIn === 'shared'
    ? [toolApprovals.never, toolApprovals.always, toolApprovals.guest]
    : [toolApprovals.never, toolApprovals.always]
