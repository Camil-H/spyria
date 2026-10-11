import type { MemberId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { transitioned } from '../domain/runtime.ts'
import { assertCanManage, assertNotRemoved } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  workspaceId: WorkspaceId
  memberId: MemberId
  role: 'admin' | 'member'
  hostId: RuntimeHostId
  now: number
}

export const removeRuntimeHost = ({ transactor }: Dependencies, { workspaceId, memberId, role, hostId, now }: Input) =>
  transactor.run(async ({ runtimeHosts, runtimes }) => {
    const host = assertCanManage(assertNotRemoved(await runtimeHosts.get(workspaceId, hostId)), memberId, role)
    await runtimeHosts.save({ ...host, removedAt: now })
    for (const runtime of await runtimes.lockOnHost(workspaceId, hostId))
      if (runtime.failure !== 'lost') await runtimes.save(transitioned(runtime, 'failed', now, 'lost'))
  })
