import type { RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { type HostDeclaration, signInsOf } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  workspaceId: WorkspaceId
  hostId: RuntimeHostId
  memoryFreeBytes: number
  running: number
  signedIn?: string[]
  credentialsChangedAt?: HostDeclaration['credentialsChangedAt']
  now: number
}

export const recordHostHeartbeat = (
  { transactor }: Dependencies,
  { workspaceId, hostId, memoryFreeBytes, running, signedIn, credentialsChangedAt, now }: Input,
) =>
  transactor.run(async ({ runtimeHosts }) => {
    const host = await runtimeHosts.get(workspaceId, hostId)
    if (host.removedAt !== null) return
    await runtimeHosts.save({
      ...host,
      capacity: host.capacity && {
        ...host.capacity,
        memoryFreeBytes,
        ...(signedIn && signInsOf({ signedIn, credentialsChangedAt }, host.capacity.expiredSignIns)),
      },
      runningRuntimes: running,
      lastSeenAt: now,
    })
  })
