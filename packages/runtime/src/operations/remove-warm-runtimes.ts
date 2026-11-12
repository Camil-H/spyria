import type { WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { runtimeJobTypes } from '../domain/runtime.ts'

export const removeWarmRuntimes = ({ transactor }: { transactor: RuntimeTransactor }, workspaceId: WorkspaceId) =>
  transactor.run(async ({ warmRuntimes, jobs }) => {
    for (const warm of await warmRuntimes.lockAll(workspaceId)) {
      await warmRuntimes.delete(warm)
      await jobs.enqueue(workspaceId, runtimeJobTypes.discard, { runtimeId: warm.id, hostId: warm.hostId })
    }
  })

export const refillWarmPools = ({ transactor }: { transactor: RuntimeTransactor }, workspaceId: WorkspaceId) =>
  transactor.run(({ jobs }) => jobs.enqueue(workspaceId, runtimeJobTypes.warm, {}))
