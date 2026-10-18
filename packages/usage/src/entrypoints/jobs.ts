import type { Job } from '@hq/db/zero-queries'
import type { GatewayUsageLogs } from '../contracts/usage-sync.ts'
import { auditJobTypes } from '../domain/audit.ts'
import { usageJobTypes, usageSync } from '../domain/usage.ts'
import { createPostgresAuditTransactor } from '../integrations/postgres-audit-log.ts'
import { createPostgresUsageLedger } from '../integrations/postgres-usage-ledger.ts'
import { sweepAuditRecords } from '../operations/audit-log.ts'
import { syncUsage } from '../operations/sync-usage.ts'

type UsageJob = Pick<Job, 'workspaceId' | 'transact'>

export const syncUsageNow = async (logs: GatewayUsageLogs, { workspaceId, transact }: UsageJob) => {
  const { behindMilliseconds } = await syncUsage(
    { logs, ledger: createPostgresUsageLedger(transact) },
    { workspaceId, now: new Date() },
  )
  if (behindMilliseconds > usageSync.alertBehindMilliseconds)
    console.error(
      `Usage of ${workspaceId} is ${Math.round(behindMilliseconds / 60_000)} minutes behind the gateway logs`,
    )
}

export const createUsageJobs = (logs: GatewayUsageLogs) => ({
  [usageJobTypes.sync]: async (job: UsageJob) => {
    try {
      await syncUsageNow(logs, job)
    } catch (error) {
      console.error(`The usage sync of ${job.workspaceId} failed`, error)
    } finally {
      await createPostgresUsageLedger(job.transact).scheduleNextSync(job.workspaceId, usageSync.intervalMilliseconds)
    }
  },
})

export const auditJobs = {
  [auditJobTypes.sweep]: ({ workspaceId, transact }: UsageJob) =>
    sweepAuditRecords({ transactor: createPostgresAuditTransactor(transact, workspaceId) }),
}
