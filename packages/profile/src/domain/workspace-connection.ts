import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { InvalidConnection } from './errors.ts'

export const connectionSignIns = { member: 'member', shared: 'shared' } as const
export type ConnectionSignIn = (typeof connectionSignIns)[keyof typeof connectionSignIns]
export type ConnectionTool = { name: string; readOnly: boolean }
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
  allowedTools: string[]
}
export type ConnectionRestriction = { connectionId: string; memberId: MemberId; allowedTools: string[] }
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

export const memberToolsOf = (
  connection: WorkspaceConnection,
  restrictions: readonly ConnectionRestriction[],
  memberId: MemberId,
) => {
  const restriction = restrictions.find((row) => row.connectionId === connection.id && row.memberId === memberId)
  return connection.allowedTools.filter((tool) => restriction?.allowedTools.includes(tool) ?? true)
}

export const knownToolsOf = (connection: WorkspaceConnection, tools: readonly string[]) => {
  const unknown = tools.find((tool) => !connection.tools.some(({ name }) => name === tool))
  if (unknown !== undefined) throw new InvalidConnection(`${connection.name} has no tool ${unknown}`)
  return connection.tools.flatMap(({ name }) => (tools.includes(name) ? [name] : []))
}

export const allowedAfterRelisting = (connection: WorkspaceConnection, tools: readonly ConnectionTool[]) =>
  tools.flatMap(({ name }) =>
    connection.allowedTools.includes(name) || !connection.tools.some((tool) => tool.name === name) ? [name] : [],
  )

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
  restrictions: readonly ConnectionRestriction[],
  memberId: MemberId,
) =>
  connection.signIn === connectionSignIns.member &&
  connection.setupId === null &&
  memberToolsOf(connection, restrictions, memberId).length > 0
