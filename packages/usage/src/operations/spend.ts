import type { MemberId } from '@hq/kernel'
import type { SpendLedger, SpendTransactor } from '../contracts/spend.ts'
import { NotWorkspaceAdmin } from '../domain/errors.ts'
import { type SpendDimension, type SpendFilter, type SpendReport, spendReportOf } from '../domain/spend.ts'

type Dependencies = { transactor: SpendTransactor }
type Request = { memberId: MemberId; filter: SpendFilter }

const reportOf = async (
  ledger: SpendLedger,
  filter: SpendFilter,
  {
    prompterId,
    tableDimensions,
    chartDimensions,
  }: { prompterId: MemberId | null; tableDimensions: SpendDimension[]; chartDimensions: SpendDimension[] },
) =>
  spendReportOf({
    filter,
    calls: await ledger.calls(filter.current, filter.granularity, prompterId),
    counts: await ledger.counts(filter, prompterId),
    tableDimensions,
    chartDimensions,
    mergedPulls: prompterId ? null : await ledger.mergedPulls(filter.current),
  })

export const readWorkspaceSpend = ({ transactor }: Dependencies, { memberId, filter }: Request) =>
  transactor.run(async (ledger): Promise<SpendReport> => {
    if (!(await ledger.isActiveAdmin(memberId))) throw new NotWorkspaceAdmin('analyze costs')
    return reportOf(ledger, filter, {
      prompterId: null,
      tableDimensions: ['member', 'project', 'chat', 'model'],
      chartDimensions: ['member', 'project', 'model'],
    })
  })

export const readOwnSpend = ({ transactor }: Dependencies, { memberId, filter }: Request) =>
  transactor.run(
    (ledger): Promise<SpendReport> =>
      reportOf(ledger, filter, {
        prompterId: memberId,
        tableDimensions: ['chat', 'model'],
        chartDimensions: ['model', 'chat'],
      }),
  )
