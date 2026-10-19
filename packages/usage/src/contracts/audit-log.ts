import type { MemberId, Transactor, WorkspacePermission } from '@hq/kernel'
import type { AuditRecord } from '../domain/audit.ts'

export type AuditQuery = {
  since: Date | null
  until: Date | null
  personId: MemberId | null
  kinds: readonly string[] | null
  before: { at: string; key: string } | null
  limit: number
}

export type AuditLog = {
  permissions(memberId: MemberId): Promise<readonly WorkspacePermission[]>
  records(query: AuditQuery): Promise<AuditRecord[]>
  retentionDays(): Promise<number | null>
  setRetentionDays(retentionDays: number | null, actorId: MemberId): Promise<void>
  deleteRecordsOlderThan(retentionDays: number): Promise<void>
  scheduleSweep(delayMilliseconds: number): Promise<void>
}

export type AuditTransactor = Transactor<AuditLog>
