import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { InvalidConnection } from './errors.ts'

export type ConnectionTool = { name: string; readOnly: boolean }
export type SecretHeader = { name: string; value: string }
export type WorkspaceConnection = {
  workspaceId: WorkspaceId
  id: string
  name: string
  gatewayName: string
  url: string
  headerName: string | null
  tools: ConnectionTool[]
  allowedTools: string[]
}
export type ConnectionRestriction = { connectionId: string; memberId: MemberId; allowedTools: string[] }
export type ConnectionInput = { name: string; url: string; secretHeader?: SecretHeader | null }

const headerNamePattern = /^[A-Za-z0-9-]{1,64}$/
const gatewaySlugLength = 20

export const connectionInputOf = ({ name, url, secretHeader }: ConnectionInput) => {
  const trimmedName = name.trim()
  if (!trimmedName) throw new InvalidConnection('A connection needs a name')
  if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol))
    throw new InvalidConnection('The MCP URL must be an http or https URL')
  if (secretHeader && (!headerNamePattern.test(secretHeader.name) || !secretHeader.value))
    throw new InvalidConnection('A secret header needs a name (letters, digits, -) and a value')
  return { name: trimmedName, url, secretHeader }
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
