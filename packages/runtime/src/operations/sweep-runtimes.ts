import type { WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import {
  idleCutoffsAt,
  idleStepOf,
  runtimeJobTypes,
  sweepIntervalMilliseconds,
  transitioned,
} from '../domain/runtime.ts'
import { requestRemoval } from './remove-chat-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }

export const sweepRuntimes = (
  { transactor }: Dependencies,
  { workspaceId, now }: { workspaceId: WorkspaceId; now: number },
) =>
  transactor.run(async (unitOfWork) => {
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
  })
