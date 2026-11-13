import type { RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }

export const takeHostOffline = async ({ runtimeHosts, runtimes, warmRuntimes }: UnitOfWork, host: RuntimeHost) => {
  if (host.status === 'online') await runtimeHosts.save({ ...host, status: 'offline' })
  await runtimes.setHostOnline(host.workspaceId, host.id, false)
  for (const warm of await warmRuntimes.lockOnHost(host.workspaceId, host.id)) await warmRuntimes.delete(warm)
}

export const markHostOffline = (
  { transactor }: Dependencies,
  { workspaceId, hostId }: { workspaceId: WorkspaceId; hostId: RuntimeHostId },
) =>
  transactor.run(async (unitOfWork) =>
    takeHostOffline(unitOfWork, await unitOfWork.runtimeHosts.get(workspaceId, hostId)),
  )
