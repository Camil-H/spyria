import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { connectionsWithoutTool } from '../domain/personal-connection.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; tool: string }

export const disconnectTool = ({ transactor }: Dependencies, { workspaceId, memberId, tool }: Input) =>
  transactor.run(async ({ personalConnections }) => {
    const connections = await personalConnections.list(workspaceId, memberId)
    await personalConnections.replace(workspaceId, memberId, connectionsWithoutTool(connections, tool))
  })
