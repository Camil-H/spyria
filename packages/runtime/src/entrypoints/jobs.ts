import type { Job } from '@hq/db/zero-queries'
import { runtimeId } from '@hq/kernel'
import { z } from 'zod/mini'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import { runtimeJobs } from '../domain/runtime.ts'
import { createTransactingZeroTransactor } from '../integrations/zero-transactor.ts'
import { bringUpRuntime } from '../operations/bring-up-runtime.ts'
import { removeRuntime } from '../operations/remove-runtime.ts'
import { stopRuntime } from '../operations/stop-runtime.ts'
import { sweepRuntimes } from '../operations/sweep-runtimes.ts'

const runtimePayload = z.object({ runtimeId: z.pipe(z.string().check(z.minLength(1)), z.transform(runtimeId)) })

export const createRuntimeJobs = (provider: SandboxProvider) => {
  const forRuntime =
    (job: typeof bringUpRuntime) =>
    ({ workspaceId, payload, isLastAttempt, transact }: Job) =>
      job(
        { transactor: createTransactingZeroTransactor(transact), provider },
        { workspaceId, ...runtimePayload.parse(payload), now: Date.now(), isLastAttempt },
      )
  return {
    [runtimeJobs.create]: forRuntime(bringUpRuntime),
    [runtimeJobs.start]: forRuntime(bringUpRuntime),
    [runtimeJobs.stop]: forRuntime(stopRuntime),
    [runtimeJobs.remove]: forRuntime(removeRuntime),
    [runtimeJobs.sweep]: ({ workspaceId, transact }: Job) =>
      sweepRuntimes({ transactor: createTransactingZeroTransactor(transact) }, { workspaceId, now: Date.now() }),
  }
}
