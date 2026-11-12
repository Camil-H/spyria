import type { RuntimeHostId, WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { unknownRuntimeIdsOf } from '../domain/runtime.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider }
type Input = { workspaceId: WorkspaceId; hostId: RuntimeHostId }

export const discardUnknownRuntimes = async (
  { transactor, provider }: Dependencies,
  { workspaceId, hostId }: Input,
) => {
  const runtimeIdsOnHost = await provider.runtimeIdsOn({ workspaceId, hostId })
  const { known, warmIds } = await transactor.run(async ({ runtimes, warmRuntimes }) => ({
    known: await runtimes.findByIds(workspaceId, runtimeIdsOnHost),
    warmIds: new Set((await warmRuntimes.findByIds(workspaceId, runtimeIdsOnHost)).map(({ id }) => id as string)),
  }))
  const notWarm = runtimeIdsOnHost.filter((runtimeId) => !warmIds.has(runtimeId))
  const removals = await Promise.allSettled(
    unknownRuntimeIdsOf(notWarm, known).map((runtimeId) => provider.remove({ workspaceId, hostId, runtimeId })),
  )
  const failed = removals.find((removal) => removal.status === 'rejected')
  if (failed) throw failed.reason
}
