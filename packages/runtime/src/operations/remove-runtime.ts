import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { HostNotConnected } from '../domain/errors.ts'
import { locationOf, transitioned } from '../domain/runtime.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

export const removeRuntime = async (
  { transactor, provider }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const runtime = await transactor.run(({ runtimes }) => runtimes.lock(workspaceId, runtimeId))
  const sandbox = locationOf(runtime)
  if (runtime.state !== 'removing' || !sandbox) return
  const isRemoved = await provider.remove(sandbox).then(
    () => true,
    (error: unknown) => {
      if (!isLastAttempt || error instanceof HostNotConnected) throw error
      log.error({
        event: 'runtime.remove_failed',
        body: 'A runtime could not be removed: it is recorded as failed for the sweep to remove later',
        attributes: { 'workspace.id': workspaceId, 'runtime.id': runtimeId },
        error,
      })
      return false
    },
  )
  await recordIfUnchanged(transactor, runtime, async ({ runtimes, secrets }, current) => {
    if (!isRemoved) return runtimes.save(transitioned(current, 'failed', now, 'remove_failed'))
    await secrets.discard(current)
    await runtimes.save(transitioned(current, 'removed', now))
  })
}
