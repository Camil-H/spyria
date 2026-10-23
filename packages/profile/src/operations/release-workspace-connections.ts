import type { WorkspaceId } from '@spyria/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }

export const releaseWorkspaceConnections = (
  { transactor }: Dependencies,
  { workspaceId }: { workspaceId: WorkspaceId },
) =>
  transactor.run(async ({ workspaceConnections, gatewayJobs }) => {
    for (const { gatewayName } of await workspaceConnections.list(workspaceId))
      await gatewayJobs.removeToolServerLater({ workspaceId, gatewayName })
  })
