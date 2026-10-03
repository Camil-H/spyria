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
  const others = connections.filter((connection) => connection.tool !== tool)
  return [...others, { ...owner, tool, status: connected }]
}

export const connectionsWithoutTool = (connections: readonly PersonalConnection[], tool: string) =>
  connections.filter((connection) => connection.tool !== tool)
