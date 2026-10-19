import type { RuntimeId, WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { locationOf, transitioned } from '../domain/runtime.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number }

export const removeRuntime = async ({ transactor, provider }: Dependencies, { workspaceId, runtimeId, now }: Input) => {
  const runtime = await transactor.run(({ runtimes }) => runtimes.lock(workspaceId, runtimeId))
  const sandbox = locationOf(runtime)
  if (runtime.state !== 'removing' || !sandbox) return
  if ((await provider.status(sandbox)) !== 'missing') await provider.remove(sandbox)
  await recordIfUnchanged(transactor, runtime, async ({ runtimes, secrets }, current) => {
    await secrets.discard(current)
    await runtimes.save(transitioned(current, 'removed', now))
  })
}
