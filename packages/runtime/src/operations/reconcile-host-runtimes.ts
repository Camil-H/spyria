import type { RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { locationOf, type RuntimeState, reconciledStateOf, runtimeJobs, transitioned } from '../domain/runtime.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider }
type Input = { workspaceId: WorkspaceId; hostId: RuntimeHostId; now: number }

const unfinishedJobs: Partial<Record<RuntimeState, string>> = {
  stopping: runtimeJobs.stop,
  removing: runtimeJobs.remove,
}

export const reconcileHostRuntimes = async (
  { transactor, provider }: Dependencies,
  { workspaceId, hostId, now }: Input,
) => {
  const runtimesOnHost = await transactor.run(async ({ runtimes, jobs }) => {
    const locked = await runtimes.lockOnHost(workspaceId, hostId)
    for (const runtime of locked) {
      const unfinishedJob = unfinishedJobs[runtime.state]
      if (unfinishedJob) await jobs.enqueue(workspaceId, unfinishedJob, { runtimeId: runtime.id })
    }
    return locked
  })
  for (const runtime of runtimesOnHost) {
    const sandbox = locationOf(runtime)
    if (!sandbox || (runtime.state !== 'running' && runtime.state !== 'stopped')) continue
    const reconciled = reconciledStateOf(runtime, await provider.status(sandbox))
    if (reconciled)
      await recordIfUnchanged(transactor, runtime, ({ runtimes }, current) =>
        runtimes.save({ ...transitioned(current, reconciled, now), lastActiveAt: now }),
      )
  }
}
