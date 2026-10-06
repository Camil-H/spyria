import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { hashSecret } from '../domain/claim.ts'
import { HostNotRegistered, HostRemoved } from '../domain/errors.ts'
import { capacityOf, type HostSystem } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type ConnectedHost = { workspaceId: WorkspaceId; hostId: RuntimeHostId }
type Input = { token: string; system: HostSystem; now: number; beforeOnline?: (host: ConnectedHost) => void }

export const recordHostHello = async ({ transactor }: Dependencies, { token, system, now, beforeOnline }: Input) => {
  const tokenHash = await hashSecret(token)
  return transactor.run(async ({ runtimeHosts, runtimes }) => {
    const host = (await runtimeHosts.findBySecretHash('token', tokenHash))?.host
    if (!host) throw new HostNotRegistered()
    if (host.removedAt !== null) throw new HostRemoved()
    const connected = { workspaceId: host.workspaceId, hostId: host.id }
    beforeOnline?.(connected)
    await runtimeHosts.save({ ...host, status: 'online', capacity: capacityOf(system), lastSeenAt: now })
    await runtimes.setHostOnline(host.workspaceId, host.id, true)
    return connected
  })
}
