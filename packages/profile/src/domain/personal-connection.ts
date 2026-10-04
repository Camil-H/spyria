import type { MemberId, WorkspaceId } from '@hq/kernel'
import { ToolNotInCatalog } from './errors.ts'

export type PersonalConnection = Readonly<{
  workspaceId: WorkspaceId
  memberId: MemberId
  tool: string
  status: string
}>

const connected = 'Connected'

export const connectionsWithTool = (
  connections: readonly PersonalConnection[],
  owner: Pick<PersonalConnection, 'workspaceId' | 'memberId'>,
  tool: string,
  catalog: readonly string[],
): readonly PersonalConnection[] => {
  if (!catalog.includes(tool)) throw new ToolNotInCatalog(tool)
  const connection = { ...owner, tool, status: connected }
  return connections.some((candidate) => candidate.tool === tool)
    ? connections.map((candidate) => (candidate.tool === tool ? connection : candidate))
    : [...connections, connection]
}

export const connectionsWithoutTool = (connections: readonly PersonalConnection[], tool: string) =>
  connections.filter((connection) => connection.tool !== tool)
