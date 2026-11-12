import { log, type RuntimeHostId, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { RepositoryAccess } from '../contracts/repositories.ts'
import type { SandboxLocation, SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { isAgentOutOfDate } from '../domain/agent-version.ts'
import { AgentOutOfDate, RepositoryAccessMissing } from '../domain/errors.ts'
import { runtimeJobTypes } from '../domain/runtime.ts'
import { failedWarmRuntime, type WarmRuntime, warmCheckIntervalMilliseconds } from '../domain/warm-runtime.ts'
import { callSpyriaAgent, waitUntilReady } from './call-spyria-agent.ts'

type Dependencies = {
  transactor: RuntimeTransactor
  provider: SandboxProvider
  repositories?: RepositoryAccess
  warmCheckMilliseconds?: number
}
type Input = {
  workspaceId: WorkspaceId
  runtimeId: RuntimeId
  hostId: RuntimeHostId
  now: number
  isLastAttempt: boolean
}

const removeUnlessOwned = async (
  { transactor, provider }: Pick<Dependencies, 'transactor' | 'provider'>,
  sandbox: SandboxLocation & { runtimeId: RuntimeId },
) => {
  const isOwned = await transactor.run(
    async ({ warmRuntimes, runtimes }) =>
      Boolean(await warmRuntimes.lock(sandbox.workspaceId, sandbox.runtimeId)) ||
      (await runtimes.findByIds(sandbox.workspaceId, [sandbox.runtimeId])).length > 0,
  )
  if (!isOwned) await provider.remove(sandbox).catch(() => {})
}

export const sandboxOf = (warm: WarmRuntime) => ({
  workspaceId: warm.workspaceId,
  hostId: warm.hostId,
  runtimeId: warm.id,
  apiKeyId: warm.apiKeyId,
})

export const failWarmRuntime = async (
  { transactor, provider }: Pick<Dependencies, 'transactor' | 'provider'>,
  warm: WarmRuntime,
  { reason, now, error }: { reason: string; now: number; error?: unknown },
) => {
  await transactor.run(async ({ warmRuntimes }) => {
    const current = await warmRuntimes.lock(warm.workspaceId, warm.id)
    if (current) await warmRuntimes.save(failedWarmRuntime(current, now))
  })
  await provider.remove(sandboxOf(warm)).catch(() => {})
  log.warn({
    event: 'runtime.warm_failed',
    body: 'A runtime kept ready could not be prepared; its repository waits an hour before another one',
    attributes: { 'workspace.id': warm.workspaceId, 'runtime.id': warm.id, 'runtime.warm_reason': reason },
    error,
  })
}

const preparedRepositoryOf = async (repositories: RepositoryAccess | undefined, warm: WarmRuntime) => {
  if (!repositories) throw new RepositoryAccessMissing()
  const { url, token } = await repositories.cloneOf(warm.workspaceId, warm.repository)
  return { url, token, setup_command: warm.setupCommand }
}

export const warmUpRuntime = async (
  { transactor, provider, repositories, warmCheckMilliseconds = warmCheckIntervalMilliseconds }: Dependencies,
  { workspaceId, runtimeId, hostId, now, isLastAttempt }: Input,
) => {
  const warm = await transactor.run(({ warmRuntimes }) => warmRuntimes.lock(workspaceId, runtimeId))
  if (!warm) return removeUnlessOwned({ transactor, provider }, { workspaceId, hostId, runtimeId })
  if (warm.state !== 'creating') return
  const sandbox = sandboxOf(warm)
  try {
    const status = await provider.status(sandbox)
    if (status === 'missing')
      await provider.create({
        ...sandbox,
        image: warm.image,
        setupSnapshot: { repository: warm.repository, setupCommand: warm.setupCommand },
      })
    if (status !== 'running') await provider.start(sandbox)
    const readiness = await waitUntilReady(provider.connect(sandbox), runtimeId)
    if (isAgentOutOfDate(readiness)) throw new AgentOutOfDate(readiness.protocolVersion)
    const repository = await preparedRepositoryOf(repositories, warm)
    await callSpyriaAgent(provider, sandbox, 'POST', '/api/prepare', { repository })
    const isStillWanted = await transactor.run(async ({ warmRuntimes, jobs }) => {
      const current = await warmRuntimes.lock(workspaceId, runtimeId)
      if (current?.state !== 'creating') return false
      await warmRuntimes.save({
        ...current,
        state: 'preparing',
        agentVersion: readiness.agentVersion,
        agentProtocolVersion: readiness.protocolVersion,
        stateChangedAt: now,
      })
      await jobs.enqueue(workspaceId, runtimeJobTypes.warmCheck, { runtimeId }, warmCheckMilliseconds)
      return true
    })
    if (!isStillWanted) await removeUnlessOwned({ transactor, provider }, sandbox)
  } catch (error) {
    const isRetried =
      !isLastAttempt && !(error instanceof AgentOutOfDate) && !(error instanceof RepositoryAccessMissing)
    const current = await transactor.run(({ warmRuntimes }) => warmRuntimes.lock(workspaceId, runtimeId))
    if (current?.state !== 'creating') return removeUnlessOwned({ transactor, provider }, sandbox)
    if (isRetried) throw error
    await failWarmRuntime({ transactor, provider }, warm, { reason: 'warm_up_failed', now, error })
  }
}
