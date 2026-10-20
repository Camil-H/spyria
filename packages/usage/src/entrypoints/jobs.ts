import type { Job } from '@spyria/db/zero-queries'
import { log } from '@spyria/kernel'
import type { GatewayUsageLogs } from '../contracts/usage-sync.ts'
import { auditJobTypes } from '../domain/audit.ts'
import { usageJobTypes, usageSync } from '../domain/usage.ts'
import { createPostgresAuditTransactor } from '../integrations/postgres-audit-log.ts'
import { createPostgresBudgetTransactor } from '../integrations/postgres-budgets.ts'
import { createPostgresUsageLedger } from '../integrations/postgres-usage-ledger.ts'
import { sweepAuditRecords } from '../operations/audit-log.ts'
import { recordBudgetAlerts } from '../operations/budgets.ts'
import { syncUsage } from '../operations/sync-usage.ts'

type UsageJob = Pick<Job, 'workspaceId' | 'transact'>

export const syncUsageNow = async (logs: GatewayUsageLogs, { workspaceId, transact }: UsageJob) => {
  const { behindMilliseconds } = await syncUsage(
    { logs, ledger: createPostgresUsageLedger(transact) },
    { workspaceId, now: new Date() },
  )
  await recordBudgetAlerts({ transactor: createPostgresBudgetTransactor(transact, workspaceId) }, { now: new Date() })
  if (behindMilliseconds > usageSync.alertBehindMilliseconds)
    log.error({
      event: 'usage.sync_behind',
      body: 'Usage is behind the gateway logs',
      attributes: { 'workspace.id': workspaceId, 'usage.behind_minutes': Math.round(behindMilliseconds / 60_000) },
    })
}

export const createUsageJobs = (logs: GatewayUsageLogs) => ({
  [usageJobTypes.sync]: async (job: UsageJob) => {
    try {
      await syncUsageNow(logs, job)
    } catch (error) {
      log.error({
        event: 'usage.sync_failed',
        body: 'The usage sync failed',
        attributes: { 'workspace.id': job.workspaceId },
        error,
      })
    } finally {
      await createPostgresUsageLedger(job.transact).scheduleNextSync(job.workspaceId, usageSync.intervalMilliseconds)
    }
  },
})

export const auditJobs = {
  [auditJobTypes.sweep]: ({ workspaceId, transact }: UsageJob) =>
    sweepAuditRecords({ transactor: createPostgresAuditTransactor(transact, workspaceId) }),
}
