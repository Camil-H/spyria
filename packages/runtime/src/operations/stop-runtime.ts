import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { HostNotConnected } from '../domain/errors.ts'
import { locationOf, transitioned } from '../domain/runtime.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

export const stopRuntime = async (
  { transactor, provider }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const runtime = await transactor.run(({ runtimes }) => runtimes.lock(workspaceId, runtimeId))
  const sandbox = locationOf(runtime)
  if (runtime.state !== 'stopping' || !sandbox) return
  await provider.stop(sandbox).catch((error: unknown) => {
    if (!isLastAttempt || error instanceof HostNotConnected) throw error
    log.error({
      event: 'runtime.stop_failed',
      body: 'A runtime could not be stopped: it is recorded as stopped',
      attributes: { 'workspace.id': workspaceId, 'runtime.id': runtimeId },
      error,
    })
  })
  await recordIfUnchanged(transactor, runtime, ({ runtimes }, current) =>
    runtimes.save(transitioned(current, 'stopped', now)),
  )
}
