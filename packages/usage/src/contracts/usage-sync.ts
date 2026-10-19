import type { WorkspaceId } from '@spyria/kernel'
import type { ModelCall } from '../domain/usage.ts'

export type GatewayUsageLogs = {
  since(workspaceId: WorkspaceId, since: Date): Promise<{ calls: ModelCall[]; oldestPendingAt?: Date }>
}

export type UsageLedger = {
  logsSince(workspaceId: WorkspaceId): Promise<Date | undefined>
  record(
    workspaceId: WorkspaceId,
    window: { readFrom: Date | undefined; nextLogsSince: Date },
    calls: readonly ModelCall[],
  ): Promise<void>
  scheduleNextSync(workspaceId: WorkspaceId, delayMilliseconds: number): Promise<void>
}
