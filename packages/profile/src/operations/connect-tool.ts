import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { connectedTool } from '../domain/personal-connection.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; tool: string }

export const connectTool = ({ transactor }: Dependencies, { workspaceId, memberId, tool }: Input) =>
  transactor.run(async ({ personalConnections }) =>
    personalConnections.connect(
      connectedTool({ workspaceId, memberId }, tool, await personalConnections.toolCatalog()),
    ),
  )
