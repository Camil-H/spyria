import type { MemberId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { transitioned } from '../domain/runtime.ts'
import { assertCanManage, assertNotRemoved, type RuntimeHost } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  workspaceId: WorkspaceId
  memberId: MemberId
  role: 'admin' | 'member'
  hostId: RuntimeHostId
  now: number
}

export const retireHost = async (
  { runtimeHosts, runtimes }: Pick<UnitOfWork, 'runtimeHosts' | 'runtimes'>,
  host: RuntimeHost,
  now: number,
) => {
  await runtimeHosts.save({ ...host, removedAt: now })
  for (const runtime of await runtimes.lockOnHost(host.workspaceId, host.id))
    if (runtime.failure !== 'lost') await runtimes.save(transitioned(runtime, 'failed', now, 'lost'))
}

export const removeRuntimeHost = ({ transactor }: Dependencies, { workspaceId, memberId, role, hostId, now }: Input) =>
  transactor.run(async (unitOfWork) => {
    const host = await unitOfWork.runtimeHosts.get(workspaceId, hostId)
    await retireHost(unitOfWork, assertCanManage(assertNotRemoved(host), memberId, role), now)
  })
