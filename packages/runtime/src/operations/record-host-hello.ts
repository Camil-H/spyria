import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { hashSecret } from '../domain/claim.ts'
import { HostNotRegistered, HostRemoved } from '../domain/errors.ts'
import { capacityOf, type HostSystem } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { token: string; system: HostSystem; now: number }

export const recordHostHello = async ({ transactor }: Dependencies, { token, system, now }: Input) => {
  const tokenHash = await hashSecret(token)
  return transactor.run(async ({ runtimeHosts }) => {
    const host = (await runtimeHosts.findBySecretHash('token', tokenHash))?.host
    if (!host) throw new HostNotRegistered()
    if (host.removedAt !== null) throw new HostRemoved()
    await runtimeHosts.save({ ...host, status: 'online', capacity: capacityOf(system), lastSeenAt: now })
    return { workspaceId: host.workspaceId, hostId: host.id }
  })
}
