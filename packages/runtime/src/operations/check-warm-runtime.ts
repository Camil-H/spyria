import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { isPreparingTooLong, preparationOf, warmCheckIntervalMilliseconds } from '../domain/warm-runtime.ts'
import { callSpyriaAgent } from './call-spyria-agent.ts'
import { failWarmRuntime, sandboxOf } from './warm-up-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider; warmCheckMilliseconds?: number }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number; isLastAttempt: boolean }

export const checkWarmRuntime = async (
  { transactor, provider, warmCheckMilliseconds = warmCheckIntervalMilliseconds }: Dependencies,
  { workspaceId, runtimeId, now, isLastAttempt }: Input,
) => {
  const warm = await transactor.run(({ warmRuntimes }) => warmRuntimes.lock(workspaceId, runtimeId))
  if (warm?.state !== 'preparing') return undefined
  const sandbox = sandboxOf(warm)
  const fail = (reason: string, error?: unknown) =>
    failWarmRuntime({ transactor, provider }, warm, { reason, now, error })
  const answer = await callSpyriaAgent(provider, sandbox, 'GET', '/api/prepare').catch((error: unknown) => {
    if (!isLastAttempt) throw error
    return fail('preparation_unreadable', error)
  })
  if (answer === undefined) return undefined
  const preparation = preparationOf(answer)
  if (preparation.state === 'failed') return fail('preparation_failed')
  if (preparation.state === 'preparing') {
    if (isPreparingTooLong(warm, now)) return fail('preparation_too_long')
    return { retryInMilliseconds: warmCheckMilliseconds }
  }
  if (preparation.isSetUp)
    await provider
      .snapshot({ ...sandbox, setupSnapshot: { repository: warm.repository, setupCommand: warm.setupCommand } })
      .catch((error) =>
        log.warn({
          event: 'runtime.snapshot_failed',
          body: 'Taking the snapshot of a repository after its setup failed',
          attributes: { 'workspace.id': workspaceId, 'runtime.id': runtimeId },
          error,
        }),
      )
  await transactor.run(async ({ warmRuntimes }) => {
    const current = await warmRuntimes.lock(workspaceId, runtimeId)
    if (current?.state === 'preparing')
      await warmRuntimes.save({ ...current, state: 'ready', baseBranch: preparation.branch, stateChangedAt: now })
  })
  return undefined
}
