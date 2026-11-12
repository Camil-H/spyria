import type { Job } from '@spyria/db/zero-queries'
import { runtimeHostId, runtimeId } from '@spyria/kernel'
import { z } from 'zod/mini'
import type { RepositoryAccess } from '../contracts/repositories.ts'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import { runtimeJobTypes } from '../domain/runtime.ts'
import { createTransactingZeroTransactor } from '../integrations/zero-transactor.ts'
import { bringUpRuntime } from '../operations/bring-up-runtime.ts'
import { checkWarmRuntime } from '../operations/check-warm-runtime.ts'
import { fillWarmPools } from '../operations/fill-warm-pools.ts'
import { removeRuntime } from '../operations/remove-runtime.ts'
import { stopRuntime } from '../operations/stop-runtime.ts'
import { sweepRuntimes } from '../operations/sweep-runtimes.ts'
import { warmUpRuntime } from '../operations/warm-up-runtime.ts'

const runtimePayload = z.object({ runtimeId: z.pipe(z.string().check(z.minLength(1)), z.transform(runtimeId)) })
const hostIdField = z.pipe(z.string().check(z.minLength(1)), z.transform(runtimeHostId))
const discardPayload = z.object({ runtimeId: z.string().check(z.minLength(1)), hostId: hostIdField })
const warmUpPayload = z.extend(runtimePayload, { hostId: hostIdField })

export const createRuntimeJobs = (
  provider: SandboxProvider,
  {
    currentImage,
    repositories,
    warmCheckMilliseconds,
  }: { currentImage?: string; repositories?: RepositoryAccess; warmCheckMilliseconds?: number } = {},
) => {
  const dependenciesOf = (transact: Job['transact']) => ({
    transactor: createTransactingZeroTransactor(transact),
    provider,
    currentImage,
    repositories,
    warmCheckMilliseconds,
  })
  const forRuntime =
    <Result>(
      job: (dependencies: ReturnType<typeof dependenciesOf>, input: Parameters<typeof bringUpRuntime>[1]) => Result,
    ) =>
    ({ workspaceId, payload, isLastAttempt, transact }: Job) =>
      job(dependenciesOf(transact), { workspaceId, ...runtimePayload.parse(payload), now: Date.now(), isLastAttempt })
  return {
    [runtimeJobTypes.create]: forRuntime(bringUpRuntime),
    [runtimeJobTypes.start]: forRuntime(bringUpRuntime),
    [runtimeJobTypes.stop]: forRuntime(stopRuntime),
    [runtimeJobTypes.remove]: forRuntime(removeRuntime),
    [runtimeJobTypes.warmUp]: ({ workspaceId, payload, isLastAttempt, transact }: Job) =>
      warmUpRuntime(dependenciesOf(transact), {
        workspaceId,
        ...warmUpPayload.parse(payload),
        now: Date.now(),
        isLastAttempt,
      }),
    [runtimeJobTypes.warmCheck]: forRuntime(checkWarmRuntime),
    [runtimeJobTypes.discard]: ({ workspaceId, payload }: Job) =>
      provider.remove({ workspaceId, ...discardPayload.parse(payload) }),
    [runtimeJobTypes.sweep]: ({ workspaceId, transact }: Job) =>
      sweepRuntimes({ transactor: createTransactingZeroTransactor(transact) }, { workspaceId, now: Date.now() }),
    [runtimeJobTypes.warm]: ({ workspaceId, transact }: Job) =>
      fillWarmPools(dependenciesOf(transact), { workspaceId, now: Date.now() }),
  }
}
