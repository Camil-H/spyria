import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; hostId: RuntimeHostId; memoryFreeBytes: number; running: number; now: number }

export const recordHostHeartbeat = (
  { transactor }: Dependencies,
  { workspaceId, hostId, memoryFreeBytes, running, now }: Input,
) =>
  transactor.run(async ({ runtimeHosts }) => {
    const host = await runtimeHosts.get(workspaceId, hostId)
    if (host.removedAt !== null) return
    await runtimeHosts.save({
      ...host,
      capacity: host.capacity && { ...host.capacity, memoryFreeBytes },
      runningRuntimes: running,
      lastSeenAt: now,
    })
  })
