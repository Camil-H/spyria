import type { MemberId, ProjectId } from '@hq/kernel'

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
