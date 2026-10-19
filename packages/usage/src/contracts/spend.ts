import type { MemberId, Transactor, WorkspacePermission } from '@hq/kernel'
import type { MergedPull, SpendCall, SpendCounts, SpendFilter, SpendGranularity, SpendRange } from '../domain/spend.ts'

export type SpendLedger = {
  permissions(memberId: MemberId): Promise<readonly WorkspacePermission[]>
  calls(range: SpendRange, granularity: SpendGranularity, prompterId: MemberId | null): Promise<SpendCall[]>
  counts(filter: SpendFilter, prompterId: MemberId | null): Promise<{ current: SpendCounts; previous: SpendCounts }>
  mergedPulls(range: SpendRange): Promise<MergedPull[]>
}

export type SpendTransactor = Transactor<SpendLedger>
