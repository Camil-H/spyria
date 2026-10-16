import type { WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { idleStepOf, runtimeJobTypes, sweepIntervalMilliseconds, transitioned } from '../domain/runtime.ts'
import { requestRemoval } from './remove-chat-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor }

export const sweepRuntimes = (
  { transactor }: Dependencies,
  { workspaceId, now }: { workspaceId: WorkspaceId; now: number },
) =>
  transactor.run(async (unitOfWork) => {
    for (const runtime of await unitOfWork.runtimes.lockSweepable(workspaceId)) {
      const step = idleStepOf(runtime, now)
      if (step === 'removing') await requestRemoval(unitOfWork, runtime, now)
      if (step === 'stopping') {
        await unitOfWork.runtimes.save(transitioned(runtime, step, now))
        await unitOfWork.jobs.enqueue(workspaceId, runtimeJobTypes.stop, { runtimeId: runtime.id })
      }
    }
    await unitOfWork.jobs.enqueue(workspaceId, runtimeJobTypes.sweep, {}, sweepIntervalMilliseconds)
  })
