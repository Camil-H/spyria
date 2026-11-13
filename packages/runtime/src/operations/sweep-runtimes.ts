import type { WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import {
  idleCutoffsAt,
  idleStepOf,
  runtimeJobTypes,
  sweepIntervalMilliseconds,
  transitioned,
} from '../domain/runtime.ts'
import { isHostStale } from '../domain/runtime-host.ts'
import { takeHostOffline } from './mark-host-offline.ts'
import { requestRemoval } from './remove-chat-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }

const takeStaleHostsOffline = async ({ transactor }: Dependencies, workspaceId: WorkspaceId, now: number) => {
  const onlineHosts = await transactor.run(({ runtimeHosts }) => runtimeHosts.listOnline(workspaceId))
  for (const staleHost of onlineHosts.filter((host) => isHostStale(host, now)))
    await transactor.run(async (unitOfWork) => {
      const host = await unitOfWork.runtimeHosts.get(workspaceId, staleHost.id)
      if (isHostStale(host, now)) await takeHostOffline(unitOfWork, host)
    })
}

export const sweepRuntimes = async (
  { transactor }: Dependencies,
  { workspaceId, now }: { workspaceId: WorkspaceId; now: number },
) => {
  await takeStaleHostsOffline({ transactor }, workspaceId, now)
  await transactor.run(async (unitOfWork) => {
    for (const runtime of await unitOfWork.runtimes.lockIdle(workspaceId, idleCutoffsAt(now))) {
      const step = idleStepOf(runtime, now)
      if (step === 'removing') await requestRemoval(unitOfWork, runtime, now)
      if (step === 'stopping') {
        await unitOfWork.runtimes.save(transitioned(runtime, step, now))
        await unitOfWork.jobs.enqueue(workspaceId, runtimeJobTypes.stop, { runtimeId: runtime.id })
      }
    }
    await unitOfWork.runtimeHosts.expireClaims(workspaceId, now)
    await unitOfWork.jobs.enqueue(workspaceId, runtimeJobTypes.sweep, {}, sweepIntervalMilliseconds)
    if ((await unitOfWork.workspaces.warmPoolsOf(workspaceId)).length > 0)
      await unitOfWork.jobs.enqueue(workspaceId, runtimeJobTypes.warm, {})
  })
}
