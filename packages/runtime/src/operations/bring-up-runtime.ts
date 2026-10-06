import type { RuntimeId, WorkspaceId } from '@hq/kernel'
import type { SandboxProvider, SandboxTransport } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { ApiKeyMissing, RuntimeNotReady } from '../domain/errors.ts'
import { locationOf, transitioned } from '../domain/runtime.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

const readyBudgetMilliseconds = 15_000
const readyPollMilliseconds = 250
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const isReady = (transport: SandboxTransport) =>
  transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
    (response) => response.status === 200,
    () => false,
  )

const waitUntilReady = async (transport: SandboxTransport, runtimeId: RuntimeId) => {
  for (
    const deadline = Date.now() + readyBudgetMilliseconds;
    !(await isReady(transport));
    await sleep(readyPollMilliseconds)
  )
    if (Date.now() > deadline) throw new RuntimeNotReady(runtimeId)
}

export const bringUpRuntime = async (
  { transactor, provider }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const { runtime, apiKey } = await transactor.run(async ({ runtimes, secrets }) => {
    const runtime = await runtimes.lock(workspaceId, runtimeId)
    return { runtime, apiKey: await secrets.valueOf(runtime, 'apiKey') }
  })
  const sandbox = locationOf(runtime)
  if ((runtime.state !== 'creating' && runtime.state !== 'starting') || !sandbox) return
  try {
    const status = await provider.status(sandbox)
    if (status === 'missing') {
      if (!apiKey) throw new ApiKeyMissing(runtimeId)
      await provider.create({ ...sandbox, image: runtime.image, apiKey })
    }
    if (status !== 'running') await provider.start(sandbox)
    await waitUntilReady(provider.connect(sandbox), runtimeId)
    await recordIfUnchanged(transactor, runtime, ({ runtimes }, current) =>
      runtimes.save({ ...transitioned(current, 'running', now), lastActiveAt: now }),
    )
  } catch (error) {
    if (!isLastAttempt) throw error
    const failure = runtime.state === 'creating' ? 'create_failed' : 'start_failed'
    await recordIfUnchanged(transactor, runtime, ({ runtimes }, current) =>
      runtimes.save(transitioned(current, 'failed', now, failure)),
    )
    console.error(`Runtime ${runtimeId} ${failure}: ${error instanceof Error ? error.message : 'unknown error'}`)
  }
}
