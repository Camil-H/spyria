import type { ActorKind, Integration, MemberId } from '@spyria/kernel'
import { InvalidAuditFilter, InvalidRetention } from './errors.ts'

export const auditKindsByGroup = {
  Members: ['member.invited', 'invite.revoked', 'member.joined', 'member.role_changed', 'member.removed'],
  Workspace: ['workspace.deleted', 'workspace.restored'],
  'Sign-in': ['sso.configured', 'sso.secret_rotated', 'sso.domain_verified'],
  GitHub: ['github.configured', 'github.secret_rotated'],
  Connections: ['connection.added', 'connection.updated', 'connection.removed', 'connection.restricted'],
  Chats: [
    'chat.transferred',
    'chat.member.invited',
    'chat.member.joined',
    'chat.member.role_changed',
    'chat.member.removed',
    'chat.member.left',
    'chat.visibility_changed',
    'chat.forked',
    'message.deleted',
  ],
  'Tool calls': ['tool.called'],
  Publishing: [
    'branch.pushed',
    'pull_request.opened',
    'pull_request.open',
    'pull_request.draft',
    'pull_request.merged',
    'pull_request.closed',
  ],
  Budgets: ['budget.changed', 'budget.threshold_reached'],
  Roles: [
    'role.created',
    'role.updated',
    'role.deleted',
    'workspace_role.created',
    'workspace_role.updated',
    'workspace_role.deleted',
  ],
} as const
export type AuditGroup = keyof typeof auditKindsByGroup
export const auditGroups = Object.keys(auditKindsByGroup) as AuditGroup[]

const actionByKind: Record<string, string> = {
  'member.invited': 'Invited a member',
  'invite.revoked': 'Revoked an invite',
  'member.joined': 'Joined the workspace',
  'member.role_changed': "Changed a member's role",
  'member.removed': 'Removed a member',
  'sso.configured': 'Configured SSO',
  'sso.secret_rotated': 'Replaced the SSO client secret',
  'sso.domain_verified': 'Verified a sign-in domain',
  'github.configured': 'Configured the GitHub App',
  'github.secret_rotated': "Replaced the GitHub App's secrets",
  'connection.added': 'Added a shared connection',
  'connection.updated': 'Changed a shared connection',
  'connection.removed': 'Removed a shared connection',
  'connection.restricted': "Restricted a member's tools",
  'chat.transferred': 'Transferred a chat',
  'chat.member.invited': 'Added a member to a chat',
  'chat.member.joined': 'Joined a chat',
  'chat.member.role_changed': "Changed a chat member's role",
  'chat.member.removed': 'Removed a member from a chat',
  'chat.member.left': 'Left a chat',
  'chat.visibility_changed': "Changed a chat's visibility",
  'chat.forked': 'Started a chat from another chat',
  'message.deleted': 'Deleted a message',
  'tool.called': 'Called a tool',
  'branch.pushed': 'Pushed a branch',
  'pull_request.opened': 'Opened a pull request',
  'pull_request.open': 'Reopened a pull request',
  'pull_request.draft': 'Turned a pull request into a draft',
  'pull_request.merged': 'Merged a pull request',
  'pull_request.closed': 'Closed a pull request',
  'audit.retention_changed': 'Changed how long audit records are kept',
  'budget.changed': 'Changed a monthly AI budget',
  'budget.threshold_reached': 'A monthly AI budget reached an alert threshold',
  'role.created': 'Created a chat role',
  'role.updated': 'Changed a chat role',
  'role.deleted': 'Deleted a chat role',
  'workspace_role.created': 'Created a workspace role',
  'workspace_role.updated': 'Changed a workspace role',
  'workspace_role.deleted': 'Deleted a workspace role',
  'workspace.deleted': 'Deleted the workspace',
  'workspace.restored': 'Restored the workspace',
}

export type AuditRecord = {
  key: string
  at: string
  kind: string
  actorKind: ActorKind | null
  actorId: string | null
  actorName: string | null
  onBehalfOfName: string | null
  target: string | null
  details: Readonly<Record<string, unknown>>
}
export type AuditDetail = { label: string; value: string }
export type AuditEntry = {
  key: string
  at: string
  actorId: string | null
  person: string
  action: string
  target: string
  details: readonly AuditDetail[]
}
export type AuditFilter = {
  personId: MemberId | null
  group: AuditGroup | null
  from: Date | null
  to: Date | null
  cursor: { at: string; key: string } | null
}
export type AuditPage = { entries: readonly AuditEntry[]; nextCursor: string | null }

export const auditJobTypes = { sweep: 'audit.sweep' } as const
export const auditSweepIntervalMilliseconds = 24 * 3_600_000
export const auditPageSize = 50
export const auditCsvPageSize = 500
const dayMilliseconds = 24 * 3_600_000
const cursorPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([wcdt]:.+)$/

const labelOf = (name: string) => {
  const words = name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const valueTextOf = (value: unknown): string => {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.length === 0 ? 'None' : value.map(valueTextOf).join(', ')
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export const retentionLabelOf = (retentionDays: number | null) =>
  retentionDays === null ? 'Forever' : `${retentionDays} day${retentionDays === 1 ? '' : 's'}`

const integrationNames: Record<Integration, string> = { github: 'GitHub' }

const personOf = ({ actorKind, actorId, actorName, onBehalfOfName }: AuditRecord) => {
  if (actorKind === 'agent') return onBehalfOfName ? `${onBehalfOfName}'s agent` : 'An agent'
  if (actorKind === 'integration') return integrationNames[actorId as Integration] ?? 'An integration'
  if (actorKind === 'system' || !actorName) return onBehalfOfName ? `System, for ${onBehalfOfName}` : 'System'
  return actorName
}

export const auditEntryOf = (record: AuditRecord): AuditEntry => ({
  key: record.key,
  at: record.at,
  actorId: record.actorId,
  person: personOf(record),
  action: actionByKind[record.kind] ?? record.kind,
  target:
    record.kind === 'audit.retention_changed'
      ? retentionLabelOf((record.details.retentionDays as number | null | undefined) ?? null)
      : (record.target ?? ''),
  details: Object.entries(record.details)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([name, value]) => ({ label: labelOf(name), value: valueTextOf(value) })),
})

export const auditCursorOf = (record: Pick<AuditRecord, 'at' | 'key'>) => `${record.at}~${record.key}`

const dateOrNull = (value: string | undefined) => {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new InvalidAuditFilter()
  return date
}

export const auditFilterFrom = (query: Readonly<Record<string, string | undefined>>): AuditFilter => {
  const { person, group, from, to, cursor } = query
  if (group && !auditGroups.includes(group as AuditGroup)) throw new InvalidAuditFilter()
  const cursorMatch = cursor ? cursorPattern.exec(cursor) : null
  if (cursor && !cursorMatch) throw new InvalidAuditFilter()
  return {
    personId: (person || null) as MemberId | null,
    group: (group || null) as AuditGroup | null,
    from: dateOrNull(from),
    to: dateOrNull(to),
    cursor: cursorMatch ? { at: cursorMatch[1] ?? '', key: cursorMatch[2] ?? '' } : null,
  }
}

export const auditKindsOf = (group: AuditGroup | null) => (group ? [...auditKindsByGroup[group]] : null)

export const keptSince = (from: Date | null, retentionDays: number | null, now: Date) => {
  const retentionStart = retentionDays === null ? null : new Date(now.getTime() - retentionDays * dayMilliseconds)
  if (!retentionStart) return from
  return from && from > retentionStart ? from : retentionStart
}

export const retentionDaysFrom = (value: unknown) => {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 36_500) throw new InvalidRetention()
  return value
}

const csvFieldOf = (text: string) => {
  const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
  return /[",\n\r]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText
}

export const auditCsvHeader = 'Time,Person,Action,Target,Details\n'

export const auditCsvLinesOf = (entries: readonly AuditEntry[]) =>
  entries
    .map((entry) =>
      [
        entry.at,
        entry.person,
        entry.action,
        entry.target,
        entry.details.map(({ label, value }) => `${label}: ${value}`).join('; '),
      ]
        .map(csvFieldOf)
        .join(','),
    )
    .map((line) => `${line}\n`)
    .join('')
