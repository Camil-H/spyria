import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider, SandboxTransport } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { type AgentReadiness, isAgentOutOfDate, readinessOf } from '../domain/agent-version.ts'
import { RuntimeNotReady } from '../domain/errors.ts'
import { installFailureOf, locationOf, transitioned } from '../domain/runtime.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider; currentImage?: string }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

const readyBudgetMilliseconds = 15_000
const readyPollMilliseconds = 250
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

const readinessProbe = (transport: SandboxTransport) =>
  transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
    (response) => (response.status === 200 ? readinessOf(response.body) : undefined),
    () => undefined,
  )

const waitUntilReady = async (transport: SandboxTransport, runtimeId: RuntimeId): Promise<AgentReadiness> => {
  for (const deadline = Date.now() + readyBudgetMilliseconds; ; await sleep(readyPollMilliseconds)) {
    const readiness = await readinessProbe(transport)
    if (readiness) return readiness
    if (Date.now() > deadline) throw new RuntimeNotReady(runtimeId)
  }
}

class HarnessInstallFailed extends Error {}
class AgentOutOfDate extends Error {}

export const bringUpRuntime = async (
  { transactor, provider, currentImage }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const { runtime, harness, packageCache } = await transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.lock(workspaceId, runtimeId)
    return { runtime, ...(await runtimes.launchOptionsOf(runtime)) }
  })
  const sandbox = locationOf(runtime)
  if (!['creating', 'starting', 'installing'].includes(runtime.state) || !sandbox) return
  let started = runtime
  try {
    const status = await provider.status(sandbox)
    const isOnOldImage = currentImage !== undefined && runtime.image !== currentImage
    const image = isOnOldImage ? currentImage : runtime.image
    if (status === 'missing') await provider.create({ ...sandbox, image, packageCache })
    else if (isOnOldImage) await provider.recreate({ ...sandbox, image, packageCache })
    if (isOnOldImage) {
      started = { ...runtime, image }
      await recordIfUnchanged(transactor, runtime, ({ runtimes }, current) => runtimes.save({ ...current, image }))
    }
    if (harness && !(await provider.hasHarness({ ...sandbox, harness }))) {
      const installing = started.state === 'installing' ? started : transitioned(started, 'installing', now)
      await recordIfUnchanged(transactor, started, ({ runtimes }) => runtimes.save(installing))
      started = installing
      await provider.installHarness({ ...sandbox, harness }).catch((error: Error) => {
        throw new HarnessInstallFailed(error.message)
      })
    }
    if (status !== 'running' || isOnOldImage) await provider.start(sandbox)
    const readiness = await waitUntilReady(provider.connect(sandbox), runtimeId)
    if (isAgentOutOfDate(readiness))
      throw new AgentOutOfDate(`spyria-agent speaks protocol ${readiness.protocolVersion}`)
    await recordIfUnchanged(transactor, started, ({ runtimes }, current) =>
      runtimes.save({
        ...transitioned(current, 'running', now),
        agentVersion: readiness.agentVersion,
        agentProtocolVersion: readiness.protocolVersion,
        lastActiveAt: now,
      }),
    )
  } catch (error) {
    const isInstallFailure = error instanceof HarnessInstallFailed
    const isOutdated = error instanceof AgentOutOfDate
    if (!isLastAttempt && !isInstallFailure && !isOutdated) throw error
    const failure = isInstallFailure
      ? installFailureOf(error.message)
      : isOutdated
        ? 'outdated'
        : runtime.state === 'creating'
          ? 'create_failed'
          : 'start_failed'
    await recordIfUnchanged(transactor, started, ({ runtimes }, current) =>
      runtimes.save(transitioned(current, 'failed', now, current.hostOnline ? failure : 'no_host')),
    )
    await provider.stop(sandbox).catch(() => {})
    log.error({
      event: 'runtime.bring_up_failed',
      body: 'A runtime could not be brought up',
      attributes: { 'workspace.id': workspaceId, 'runtime.id': runtimeId, 'runtime.failure': failure },
      error,
    })
  }
}
