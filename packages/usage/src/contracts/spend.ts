import type { MemberId, Transactor, WorkspacePermission } from '@spyria/kernel'
import type {
  MergedPull,
  SpendCounts,
  SpendDimension,
  SpendDimensionRow,
  SpendFilter,
  SpendGranularity,
  SpendRange,
} from '../domain/spend.ts'

export type SpendLedger = {
  permissions(memberId: MemberId): Promise<readonly WorkspacePermission[]>
  rows(
    range: SpendRange,
    granularity: SpendGranularity,
    prompterId: MemberId | null,
    dimensions: { tableDimensions: readonly SpendDimension[]; chartDimensions: readonly SpendDimension[] },
  ): Promise<SpendDimensionRow[]>
  counts(filter: SpendFilter, prompterId: MemberId | null): Promise<{ current: SpendCounts; previous: SpendCounts }>
  mergedPulls(range: SpendRange): Promise<MergedPull[]>
}

export type SpendTransactor = Transactor<SpendLedger>
