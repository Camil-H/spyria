import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { connectionsWithTool } from '../domain/personal-connection.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; tool: string }

export const connectTool = ({ transactor }: Dependencies, { workspaceId, memberId, tool }: Input) =>
  transactor.run(async ({ personalConnections }) => {
    const connections = await personalConnections.list(workspaceId, memberId)
    const catalog = await personalConnections.toolCatalog()
    await personalConnections.replace(
      workspaceId,
      memberId,
      connectionsWithTool(connections, { workspaceId, memberId }, tool, catalog),
    )
  })
