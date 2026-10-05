import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { assertAdmin, assertNotRemoved } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; role: 'admin' | 'member'; hostId: RuntimeHostId; now: number }

export const removeRuntimeHost = ({ transactor }: Dependencies, { workspaceId, role, hostId, now }: Input) => {
  assertAdmin(role)
  return transactor.run(async ({ runtimeHosts }) => {
    await runtimeHosts.save({ ...assertNotRemoved(await runtimeHosts.get(workspaceId, hostId)), removedAt: now })
  })
}
