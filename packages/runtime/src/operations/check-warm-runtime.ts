import { log, type RuntimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { isPreparingTooLong, preparationOf, warmCheckIntervalMilliseconds } from '../domain/warm-runtime.ts'
import { callSpyriaAgent } from './spyria-agent.ts'
import { discardWarmRuntime, sandboxOf } from './warm-up-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider; warmCheckMilliseconds?: number }
type Input = { workspaceId: WorkspaceId; runtimeId: RuntimeId; now: number }

export const checkWarmRuntime = async (
  { transactor, provider, warmCheckMilliseconds = warmCheckIntervalMilliseconds }: Dependencies,
  { workspaceId, runtimeId, now }: Input,
) => {
  const warm = await transactor.run(({ warmRuntimes }) => warmRuntimes.lock(workspaceId, runtimeId))
  if (warm?.state !== 'preparing') return undefined
  const sandbox = sandboxOf(warm)
  const preparation = preparationOf(await callSpyriaAgent(provider, sandbox, 'GET', '/api/prepare'))
  if (preparation.state === 'failed') return discardWarmRuntime({ transactor, provider }, warm, 'preparation_failed')
  if (preparation.state === 'preparing') {
    if (isPreparingTooLong(warm, now)) return discardWarmRuntime({ transactor, provider }, warm, 'preparation_too_long')
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
