import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider, SandboxTransport } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { ApiKeyMissing, RuntimeNotReady } from '../domain/errors.ts'
import { installFailureOf, locationOf, transitioned } from '../domain/runtime.ts'
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

class HarnessInstallFailed extends Error {}

export const bringUpRuntime = async (
  { transactor, provider }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const { runtime, apiKey, harness } = await transactor.run(async ({ runtimes, secrets }) => {
    const runtime = await runtimes.lock(workspaceId, runtimeId)
    return {
      runtime,
      apiKey: await secrets.valueOf(runtime, 'apiKey'),
      harness: await runtimes.localHarnessOf(runtime),
    }
  })
  const sandbox = locationOf(runtime)
  if (!['creating', 'starting', 'installing'].includes(runtime.state) || !sandbox) return
  let started = runtime
  try {
    const status = await provider.status(sandbox)
    if (status === 'missing') {
      if (!apiKey) throw new ApiKeyMissing(runtimeId)
      await provider.create({ ...sandbox, image: runtime.image, apiKey })
    }
    if (harness && !(await provider.hasHarness({ ...sandbox, harness }))) {
      const installing = runtime.state === 'installing' ? runtime : transitioned(runtime, 'installing', now)
      await recordIfUnchanged(transactor, runtime, ({ runtimes }) => runtimes.save(installing))
      started = installing
      await provider.installHarness({ ...sandbox, harness }).catch((error: Error) => {
        throw new HarnessInstallFailed(error.message)
      })
    }
    if (status !== 'running') await provider.start(sandbox)
    await waitUntilReady(provider.connect(sandbox), runtimeId)
    await recordIfUnchanged(transactor, started, ({ runtimes }, current) =>
      runtimes.save({ ...transitioned(current, 'running', now), lastActiveAt: now }),
    )
  } catch (error) {
    const isInstallFailure = error instanceof HarnessInstallFailed
    if (!isLastAttempt && !isInstallFailure) throw error
    const failure = isInstallFailure
      ? installFailureOf(error.message)
      : runtime.state === 'creating'
        ? 'create_failed'
        : 'start_failed'
    await recordIfUnchanged(transactor, started, ({ runtimes }, current) =>
      runtimes.save(transitioned(current, 'failed', now, current.hostOnline ? failure : 'no_host')),
    )
    log.error({
      event: 'runtime.bring_up_failed',
      body: 'A runtime could not be brought up',
      attributes: { 'workspace.id': workspaceId, 'runtime.id': runtimeId, 'runtime.failure': failure },
      error,
    })
  }
}
