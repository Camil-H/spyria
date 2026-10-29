import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { SpendLedger, SpendTransactor } from '../contracts/spend.ts'
import { InvalidSpendFilter } from '../domain/errors.ts'
import {
  type SpendBucketCounts,
  type SpendDimension,
  type SpendFilter,
  type SpendReport,
  spendReportOf,
  spendTrendOf,
} from '../domain/spend.ts'

type Dependencies = { transactor: SpendTransactor }
type Request = { memberId: MemberId; filter: SpendFilter }
type View = { prompterId: MemberId | null; tableDimensions: SpendDimension[]; chartDimensions: SpendDimension[] }

const workspaceView: View = {
  prompterId: null,
  tableDimensions: ['member', 'project', 'chat', 'model'],
  chartDimensions: ['member', 'project', 'model'],
}
const ownView = (memberId: MemberId): View => ({
  prompterId: memberId,
  tableDimensions: ['chat', 'model'],
  chartDimensions: ['model', 'chat'],
})

const requireScopeIn = (filter: SpendFilter, { tableDimensions }: View) => {
  if (filter.scope && !tableDimensions.includes(filter.scope.dimension)) throw new InvalidSpendFilter()
}

const reportOf = async (ledger: SpendLedger, filter: SpendFilter, view: View) => {
  requireScopeIn(filter, view)
  const { prompterId, tableDimensions, chartDimensions } = view
  return spendReportOf({
    filter,
    rows: await ledger.rows(filter.current, filter.granularity, prompterId, { tableDimensions, chartDimensions }),
    counts: await ledger.counts(filter, prompterId),
    tableDimensions,
    chartDimensions,
    mergedPulls: prompterId ? null : await ledger.mergedPulls(filter.current),
  })
}

const trendOf = async (ledger: SpendLedger, filter: SpendFilter, view: View) => {
  requireScopeIn(filter, view)
  return spendTrendOf(filter, await ledger.bucketCounts(filter, view.prompterId))
}

export const readWorkspaceSpend = ({ transactor }: Dependencies, { memberId, filter }: Request) =>
  transactor.run(async (ledger): Promise<SpendReport> => {
    await requireWorkspacePermission(ledger, memberId, 'costs.view')
    return reportOf(ledger, filter, workspaceView)
  })

export const readOwnSpend = ({ transactor }: Dependencies, { memberId, filter }: Request) =>
  transactor.run((ledger): Promise<SpendReport> => reportOf(ledger, filter, ownView(memberId)))

export const readWorkspaceSpendTrend = ({ transactor }: Dependencies, { memberId, filter }: Request) =>
  transactor.run(async (ledger): Promise<SpendBucketCounts[]> => {
    await requireWorkspacePermission(ledger, memberId, 'costs.view')
    return trendOf(ledger, filter, workspaceView)
  })

export const readOwnSpendTrend = ({ transactor }: Dependencies, { memberId, filter }: Request) =>
  transactor.run((ledger): Promise<SpendBucketCounts[]> => trendOf(ledger, filter, ownView(memberId)))
