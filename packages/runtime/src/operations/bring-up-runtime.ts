import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxLocation, SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { isAgentOutOfDate } from '../domain/agent-version.ts'
import { AgentOutOfDate, HarnessInstallFailed } from '../domain/errors.ts'
import {
  failedBringUpOf,
  installFailureOf,
  locationOf,
  type Runtime,
  sandboxCleanupOf,
  transitioned,
} from '../domain/runtime.ts'
import { waitUntilReady } from './call-spyria-agent.ts'
import { recordIfUnchanged } from './record-if-unchanged.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider; currentImage?: string }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

const cleanUpOvertaken = async (
  provider: SandboxProvider,
  sandbox: SandboxLocation,
  overtaken: Runtime | undefined,
) => {
  const cleanup = overtaken && sandboxCleanupOf(overtaken)
  if (cleanup === 'remove') await provider.remove(sandbox)
  if (cleanup === 'stop') await provider.stop(sandbox)
}

export const bringUpRuntime = async (
  { transactor, provider, currentImage }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const { runtime, apiKeyId, harness, packageCache, setupSnapshot } = await transactor.run(async ({ runtimes }) => {
    const runtime = await runtimes.lock(workspaceId, runtimeId)
    return { runtime, apiKeyId: await runtimes.apiKeyIdOf(runtime), ...(await runtimes.launchOptionsOf(runtime)) }
  })
  const sandbox = locationOf(runtime)
  if (!sandbox) return
  if (!['creating', 'starting', 'installing'].includes(runtime.state))
    return cleanUpOvertaken(provider, sandbox, runtime).catch(() => {})
  let started = runtime
  try {
    const status = await provider.status(sandbox)
    const isOnOldImage = currentImage !== undefined && runtime.image !== currentImage
    const isOnOldKey = apiKeyId !== provider.currentApiKeyId
    const isRecreated = status !== 'missing' && (isOnOldImage || isOnOldKey)
    const image = isOnOldImage ? currentImage : runtime.image
    if (status === 'missing') await provider.create({ ...sandbox, image, packageCache, setupSnapshot })
    else if (isRecreated) await provider.recreate({ ...sandbox, image, packageCache, setupSnapshot })
    if (isOnOldKey) await transactor.run(({ runtimes }) => runtimes.keepApiKeyId(runtime, provider.currentApiKeyId))
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
    if (status !== 'running' || isRecreated) await provider.start(sandbox)
    const readiness = await waitUntilReady(provider.connect(sandbox), runtimeId)
    if (isAgentOutOfDate(readiness)) throw new AgentOutOfDate(readiness.protocolVersion)
    const overtaken = await recordIfUnchanged(transactor, started, ({ runtimes }, current) =>
      runtimes.save({
        ...transitioned(current, 'running', now),
        agentVersion: readiness.agentVersion,
        agentProtocolVersion: readiness.protocolVersion,
        lastActiveAt: now,
      }),
    )
    await cleanUpOvertaken(provider, sandbox, overtaken)
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
    const overtaken = await recordIfUnchanged(transactor, started, ({ runtimes }, current) =>
      runtimes.save(failedBringUpOf(current, now, failure)),
    )
    await (overtaken ? cleanUpOvertaken(provider, sandbox, overtaken) : provider.stop(sandbox)).catch(() => {})
    log.error({
      event: 'runtime.bring_up_failed',
      body: 'A runtime could not be brought up',
      attributes: { 'workspace.id': workspaceId, 'runtime.id': runtimeId, 'runtime.failure': failure },
      error,
    })
  }
}
