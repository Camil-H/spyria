import { type MemberId, requireWorkspacePermission } from '@hq/kernel'
import type { AuditTransactor } from '../contracts/audit-log.ts'
import {
  type AuditFilter,
  type AuditPage,
  auditCursorOf,
  auditEntryOf,
  auditKindsOf,
  auditSweepIntervalMilliseconds,
  keptSince,
  retentionDaysFrom,
} from '../domain/audit.ts'

type Dependencies = { transactor: AuditTransactor }

export const readAuditPage = (
  { transactor }: Dependencies,
  { memberId, filter, limit, now }: { memberId: MemberId; filter: AuditFilter; limit: number; now: Date },
) =>
  transactor.run(async (auditLog): Promise<AuditPage> => {
    await requireWorkspacePermission(auditLog, memberId, 'audit.view')
    const records = await auditLog.records({
      since: keptSince(filter.from, await auditLog.retentionDays(), now),
      until: filter.to,
      personId: filter.personId,
      kinds: auditKindsOf(filter.group),
      before: filter.cursor,
      limit: limit + 1,
    })
    const pageRecords = records.slice(0, limit)
    const lastRecord = pageRecords.at(-1)
    return {
      entries: pageRecords.map(auditEntryOf),
      nextCursor: records.length > limit && lastRecord ? auditCursorOf(lastRecord) : null,
    }
  })

export const readAuditRetention = ({ transactor }: Dependencies, { memberId }: { memberId: MemberId }) =>
  transactor.run(async (auditLog) => {
    await requireWorkspacePermission(auditLog, memberId, 'audit.view')
    return auditLog.retentionDays()
  })

export const setAuditRetention = (
  { transactor }: Dependencies,
  { memberId, retentionDays }: { memberId: MemberId; retentionDays: unknown },
) =>
  transactor.run(async (auditLog) => {
    await requireWorkspacePermission(auditLog, memberId, 'audit.view')
    const days = retentionDaysFrom(retentionDays)
    if (days !== (await auditLog.retentionDays())) await auditLog.setRetentionDays(days, memberId)
    return days
  })

export const sweepAuditRecords = ({ transactor }: Dependencies) =>
  transactor.run(async (auditLog) => {
    const retentionDays = await auditLog.retentionDays()
    if (retentionDays !== null) await auditLog.deleteRecordsOlderThan(retentionDays)
    await auditLog.scheduleSweep(auditSweepIntervalMilliseconds)
  })
