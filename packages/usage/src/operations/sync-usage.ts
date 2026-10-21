import type { WorkspaceId } from '@spyria/kernel'
import type { GatewayUsageLogs, UsageLedger } from '../contracts/usage-sync.ts'
import { nextLogsSince, usageSync } from '../domain/usage.ts'

export const syncUsage = async (
  { logs, ledger }: { logs: GatewayUsageLogs; ledger: UsageLedger },
  { workspaceId, now }: { workspaceId: WorkspaceId; now: Date },
) => {
  let readFrom = await ledger.logsSince(workspaceId)
  const since = readFrom ?? new Date(now.getTime() - usageSync.retentionMilliseconds)
  let pageFrom = since
  let next = since
  let oldestPendingAt: Date | undefined
  for (let pageNumber = 0; pageNumber < usageSync.pagesPerRun; pageNumber++) {
    const page = await logs.since(workspaceId, pageFrom)
    oldestPendingAt ??= page.oldestPendingAt
    next = nextLogsSince(since, { syncedAt: now, oldestPendingAt, nextPageFrom: page.nextPageFrom })
    if (!(await ledger.record(workspaceId, { readFrom, nextLogsSince: next }, page.calls))) break
    readFrom = next
    if (!page.nextPageFrom || page.nextPageFrom <= pageFrom) break
    pageFrom = page.nextPageFrom
  }
  return { behindMilliseconds: now.getTime() - next.getTime() }
}
