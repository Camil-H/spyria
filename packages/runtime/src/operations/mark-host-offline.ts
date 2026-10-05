import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: RuntimeTransactor }

export const markHostOffline = (
  { transactor }: Dependencies,
  { workspaceId, hostId }: { workspaceId: WorkspaceId; hostId: RuntimeHostId },
) =>
  transactor.run(async ({ runtimeHosts }) => {
    const host = await runtimeHosts.get(workspaceId, hostId)
    if (host.status === 'online') await runtimeHosts.save({ ...host, status: 'offline' })
  })
