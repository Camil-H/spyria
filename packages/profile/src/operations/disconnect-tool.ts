import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; tool: string }

export const disconnectTool = ({ transactor }: Dependencies, { workspaceId, memberId, tool }: Input) =>
  transactor.run(({ personalConnections }) => personalConnections.disconnect(workspaceId, memberId, tool))
