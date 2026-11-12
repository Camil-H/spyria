import { log, runtimeId, type WorkspaceId } from '@spyria/kernel'
import type { SandboxProvider } from '../contracts/sandbox-provider.ts'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { type HostLoad, runtimeJobTypes } from '../domain/runtime.ts'
import { type WarmRuntime, warmPlacementOf, warmPoolPlanOf } from '../domain/warm-runtime.ts'

type Dependencies = { transactor: RuntimeTransactor; provider: SandboxProvider; currentImage?: string }
type Input = { workspaceId: WorkspaceId; now: number }

const withRunning = (loads: HostLoad[], hostId: string, change: number) =>
  loads.map((load) => (load.hostId === hostId ? { ...load, running: load.running + change } : load))

export const fillWarmPools = async (
  { transactor, provider, currentImage }: Dependencies,
  { workspaceId, now }: Input,
) => {
  const { pools, onlineHostIds } = await transactor.run(async ({ runtimeHosts, warmRuntimes, workspaces, jobs }) => {
    let loads = await runtimeHosts.lockWorkspaceLoads(workspaceId)
    const pools = currentImage ? await workspaces.warmPoolsOf(workspaceId) : []
    const { removed, missing } = warmPoolPlanOf(await warmRuntimes.lockAll(workspaceId), pools, currentImage ?? '', now)
    for (const warm of removed) {
      await warmRuntimes.delete(warm)
      await jobs.enqueue(workspaceId, runtimeJobTypes.discard, { runtimeId: warm.id, hostId: warm.hostId })
      loads = withRunning(loads, warm.hostId, -1)
    }
    for (const pool of missing) {
      const { hostId } = warmPlacementOf(loads)
      if (!hostId || !currentImage) break
      const warm: WarmRuntime = {
        workspaceId,
        id: runtimeId(crypto.randomUUID()),
        repository: pool.repository,
        setupCommand: pool.command,
        hostId,
        state: 'creating',
        image: currentImage,
        apiKeyId: provider.currentApiKeyId,
        baseBranch: null,
        agentVersion: null,
        agentProtocolVersion: null,
        createdAt: now,
        stateChangedAt: now,
      }
      await warmRuntimes.add(warm)
      await jobs.enqueue(workspaceId, runtimeJobTypes.warmUp, { runtimeId: warm.id })
      loads = withRunning(loads, hostId, 1)
    }
    return { pools, onlineHostIds: loads.filter(({ online }) => online).map((load) => load.hostId) }
  })
  const keep = pools.map(({ repository, command }) => ({ repository, setupCommand: command }))
  const prunings = await Promise.allSettled(
    onlineHostIds.map((hostId) => provider.pruneSnapshots({ workspaceId, hostId, keep })),
  )
  for (const pruning of prunings)
    if (pruning.status === 'rejected')
      log.warn({
        event: 'runtime.snapshot_prune_failed',
        body: 'Removing the snapshots no repository keeps failed',
        attributes: { 'workspace.id': workspaceId },
        error: pruning.reason,
      })
}
