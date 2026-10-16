import type { ChatId, MemberId, ProjectId } from '@hq/kernel'

export type UsageMonth = string
export type UsageTotals = { tokens: number; costMicros: number; calls: number }
export type MemberUsage = UsageTotals & { memberId: MemberId; name: string }
export type ProjectUsage = UsageTotals & { projectId: ProjectId | null; name: string }
export type ChatUsage = { months: readonly UsageMonth[]; rows: readonly MemberUsage[]; total: UsageTotals }
export type WorkspaceUsage = {
  months: readonly UsageMonth[]
  total: UsageTotals
  byMember: readonly MemberUsage[]
  byProject: readonly ProjectUsage[]
}

export type ModelCall = {
  id: string
  chatId: ChatId
  prompterId: MemberId
  ownerId: MemberId | null
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costMicros: number
  status: 'success' | 'error'
  role: string | null
  calledAt: Date
}

export const usageJobTypes = { sync: 'usage.sync' } as const

export const usageSync = {
  intervalMilliseconds: 10_000,
  overlapMilliseconds: 60_000,
  retentionMilliseconds: 30 * 24 * 3_600_000,
  alertBehindMilliseconds: 3_600_000,
}

export const noUsage: UsageTotals = { tokens: 0, costMicros: 0, calls: 0 }

export const sumUsage = (rows: readonly UsageTotals[]): UsageTotals =>
  rows.reduce(
    (sum, row) => ({
      tokens: sum.tokens + row.tokens,
      costMicros: sum.costMicros + row.costMicros,
      calls: sum.calls + row.calls,
    }),
    noUsage,
  )

export const monthsNewestFirst = (rows: readonly { month: UsageMonth }[]) =>
  [...new Set(rows.map((row) => row.month))].sort().reverse()

export const nextLogsSince = (
  logsSince: Date,
  { syncedAt, oldestPendingAt }: { syncedAt: Date; oldestPendingAt?: Date },
) =>
  new Date(
    Math.max(
      logsSince.getTime(),
      Math.min(syncedAt.getTime() - usageSync.overlapMilliseconds, oldestPendingAt?.getTime() ?? Infinity),
    ),
  )
