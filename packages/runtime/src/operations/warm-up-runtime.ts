import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { RepositoryAccess } from '../contracts/repositories.ts'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { isAgentOutOfDate } from '../domain/agent-version.ts'
import { AgentOutOfDate } from '../domain/errors.ts'
import { runtimeJobTypes } from '../domain/runtime.ts'
import { type WarmRuntime, warmCheckIntervalMilliseconds } from '../domain/warm-runtime.ts'
import { callSpyriaAgent, waitUntilReady } from './spyria-agent.ts'

type Dependencies = {
  transactor: RuntimeTransactor
  provider: SandboxProvider
  repositories?: RepositoryAccess
  warmCheckMilliseconds?: number
}
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

export const sandboxOf = (warm: WarmRuntime) => ({
  workspaceId: warm.workspaceId,
  hostId: warm.hostId,
  runtimeId: warm.id,
  apiKeyId: warm.apiKeyId,
})

export const discardWarmRuntime = async (
  { transactor, provider }: Pick<Dependencies, 'transactor' | 'provider'>,
  warm: WarmRuntime,
  reason: string,
  error?: unknown,
) => {
  await transactor.run(async ({ warmRuntimes }) => {
    if (await warmRuntimes.lock(warm.workspaceId, warm.id)) await warmRuntimes.delete(warm)
  })
  await provider.remove(sandboxOf(warm)).catch(() => {})
  log.warn({
    event: 'runtime.warm_discarded',
    body: 'A runtime kept ready was removed',
    attributes: { 'workspace.id': warm.workspaceId, 'runtime.id': warm.id, 'runtime.warm_reason': reason },
    error,
  })
}

const preparedRepositoryOf = async (repositories: RepositoryAccess | undefined, warm: WarmRuntime) => {
  if (!repositories) throw new Error('No GitHub App can clone the repository')
  const { url, token } = await repositories.cloneOf(warm.workspaceId, warm.repository)
  return { url, token, setup_command: warm.setupCommand }
}

export const warmUpRuntime = async (
  { transactor, provider, repositories, warmCheckMilliseconds = warmCheckIntervalMilliseconds }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const warm = await transactor.run(({ warmRuntimes }) => warmRuntimes.lock(workspaceId, runtimeId))
  if (warm?.state !== 'creating') return
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
    await transactor.run(async ({ warmRuntimes, jobs }) => {
      const current = await warmRuntimes.lock(workspaceId, runtimeId)
      if (current?.state !== 'creating') return
      await warmRuntimes.save({
        ...current,
        state: 'preparing',
        agentVersion: readiness.agentVersion,
        agentProtocolVersion: readiness.protocolVersion,
        stateChangedAt: now,
      })
      await jobs.enqueue(workspaceId, runtimeJobTypes.warmCheck, { runtimeId }, warmCheckMilliseconds)
    })
  } catch (error) {
    if (!isLastAttempt && !(error instanceof AgentOutOfDate)) throw error
    await discardWarmRuntime({ transactor, provider }, warm, 'warm_up_failed', error)
  }
}
