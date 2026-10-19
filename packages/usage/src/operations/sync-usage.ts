import type { WorkspaceId } from '@spyria/kernel'
import type { GatewayUsageLogs, UsageLedger } from '../contracts/usage-sync.ts'
import { nextLogsSince, usageSync } from '../domain/usage.ts'

export const syncUsage = async (
  { logs, ledger }: { logs: GatewayUsageLogs; ledger: UsageLedger },
  { workspaceId, now }: { workspaceId: WorkspaceId; now: Date },
) => {
  const readFrom = await ledger.logsSince(workspaceId)
  const since = readFrom ?? new Date(now.getTime() - usageSync.retentionMilliseconds)
  const { calls, oldestPendingAt } = await logs.since(workspaceId, since)
  const next = nextLogsSince(since, { syncedAt: now, oldestPendingAt })
  await ledger.record(workspaceId, { readFrom, nextLogsSince: next }, calls)
  return { behindMilliseconds: now.getTime() - next.getTime() }
}
