import {
  type AccessLevel,
  accessLevels,
  type ConnectionTool,
  githubConnectionId,
  githubServerName,
  githubTools,
  grantedToolsOf,
  isAllowedAtLevel,
  type MemberId,
  ownValueOf,
  type ToolHolder,
  type ToolServerAccess,
  type WorkspaceId,
} from '@spyria/kernel'
import { InvalidConnection } from './errors.ts'

export type { ConnectionTool, ToolHolder, ToolServerAccess }

export const connectionSignIns = { member: 'member', shared: 'shared' } as const
export type ConnectionSignIn = (typeof connectionSignIns)[keyof typeof connectionSignIns]
export type SecretHeader = { name: string; value: string }
export type WorkspaceConnection = {
  workspaceId: WorkspaceId
  id: string
  name: string
  gatewayName: string
  url: string
  signIn: ConnectionSignIn
  setupId: string | null
  headerName: string | null
  tools: ConnectionTool[]
  isReviewed: boolean
}
export type AccessSubject = { roleId: string; memberId?: undefined } | { memberId: MemberId; roleId?: undefined }
export type AccessInput = AccessSubject & { level: AccessLevel | null; toolChanges: Record<string, boolean> }
export type ToolMarking = { name: string; readOnly: boolean }
export type ConnectionInput = {
  name: string
  url: string
  signIn: ConnectionSignIn
  secretHeader?: SecretHeader | null
}

const headerNamePattern = /^[A-Za-z0-9-]{1,64}$/
const gatewaySlugLength = 20

export const connectionInputOf = ({ name, url, signIn, secretHeader }: ConnectionInput) => {
  const trimmedName = name.trim()
  if (!trimmedName) throw new InvalidConnection('A server needs a name')
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
    throw new InvalidConnection('The address must be an http or https URL')
  if (!Object.values(connectionSignIns).includes(signIn))
    throw new InvalidConnection('Choose whether each member signs in or the server uses one shared login')
  if (signIn === connectionSignIns.member && secretHeader)
    throw new InvalidConnection('A server each member signs in to takes no shared secret')
  if (secretHeader && (!headerNamePattern.test(secretHeader.name) || !secretHeader.value))
    throw new InvalidConnection('A secret header needs a name (letters, digits, -) and a value')
  return { name: trimmedName, url, signIn, secretHeader }
}

export const gatewayNameOf = (name: string) =>
  `${
    name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, gatewaySlugLength) || 'tools'
  }_${crypto.randomUUID().slice(0, 6)}`

const requireKnownTools = (connection: WorkspaceConnection, tools: readonly string[]) => {
  const unknown = tools.find((tool) => !connection.tools.some(({ name }) => name === tool))
  if (unknown !== undefined) throw new InvalidConnection(`${connection.name} has no tool ${unknown}`)
}

export const markedToolsOf = (connection: WorkspaceConnection, markings: readonly ToolMarking[]) => {
  requireKnownTools(
    connection,
    markings.map(({ name }) => name),
  )
  return connection.tools.map((tool) => ({
    ...tool,
    readOnly: markings.find(({ name }) => name === tool.name)?.readOnly ?? tool.readOnly,
  }))
}

export const relistedToolsOf = (connection: WorkspaceConnection, tools: readonly ConnectionTool[]) =>
  tools.map((tool) => {
    const known = connection.tools.find(({ name }) => name === tool.name)
    return { ...tool, readOnly: known?.readOnly ?? false }
  })

export const accessOf = (
  connection: WorkspaceConnection,
  input: AccessInput,
  previous?: ToolServerAccess,
): ToolServerAccess | null => {
  if (input.level === null) return null
  if (!Object.values(accessLevels).includes(input.level))
    throw new InvalidConnection('Choose None, Read or Read and write')
  requireKnownTools(connection, Object.keys(input.toolChanges))
  const level = input.level
  const changes = { ...previous?.toolChanges, ...input.toolChanges }
  const toolChanges = Object.fromEntries(
    connection.tools.flatMap((tool) => {
      const isAllowed = ownValueOf(changes, tool.name)
      return typeof isAllowed === 'boolean' && isAllowed !== isAllowedAtLevel(level, tool)
        ? [[tool.name, isAllowed]]
        : []
    }),
  )
  return {
    connectionId: connection.id,
    roleId: input.roleId ?? null,
    memberId: input.memberId ?? null,
    level,
    toolChanges,
  }
}

export const editedInputOf = (previous: WorkspaceConnection, input: Omit<ConnectionInput, 'signIn'>) => {
  const edited = connectionInputOf({ ...input, signIn: previous.signIn })
  if (previous.signIn === connectionSignIns.member && edited.url !== previous.url)
    throw new InvalidConnection(
      `Members sign in to ${previous.name} at its address: remove it and add it again instead`,
    )
  return edited
}

export const canSignIn = (
  connection: WorkspaceConnection,
  accessRows: readonly ToolServerAccess[],
  holder: ToolHolder,
) => connection.signIn === connectionSignIns.member && grantedToolsOf(connection, accessRows, holder).length > 0

export const requireListedTools = (connection: WorkspaceConnection) => {
  if (connection.setupId !== null)
    throw new InvalidConnection(`Finish signing in to ${connection.name} first: its tools are not listed yet`)
  return connection
}

export const githubConnectionIn = (workspaceId: WorkspaceId): WorkspaceConnection => ({
  workspaceId,
  id: githubConnectionId,
  name: githubServerName,
  gatewayName: githubConnectionId,
  url: '',
  signIn: connectionSignIns.member,
  setupId: null,
  headerName: null,
  tools: githubTools.map(({ name, readOnly, destructive }) => ({ name, readOnly, destructive })),
  isReviewed: true,
})
