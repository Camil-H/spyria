import type { MemberId, Transactor } from '@hq/kernel'
import type { MergedPull, SpendCall, SpendCounts, SpendFilter, SpendGranularity, SpendRange } from '../domain/spend.ts'

export type SpendLedger = {
  isActiveAdmin(memberId: MemberId): Promise<boolean>
  calls(range: SpendRange, granularity: SpendGranularity, prompterId: MemberId | null): Promise<SpendCall[]>
  counts(filter: SpendFilter, prompterId: MemberId | null): Promise<{ current: SpendCounts; previous: SpendCounts }>
  mergedPulls(range: SpendRange): Promise<MergedPull[]>
}

export type SpendTransactor = Transactor<SpendLedger>
