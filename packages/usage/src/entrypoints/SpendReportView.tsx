import type { WorkspaceId } from '@spyria/kernel'
import { ErrorMessage, fieldClass, formatCost, LabelledSection, labelClass, SegmentedChoice } from '@spyria/ui'
import { lazy, type ReactNode, Suspense, useEffect, useState } from 'react'
import {
  type SpendDimension,
  type SpendFactorName,
  type SpendGranularity,
  type SpendPeriod,
  type SpendReport,
  type SpendRow,
  spendGranularities,
  spendPeriods,
} from '../domain/spend.ts'
import { formatChange, formatFactor } from './format.ts'
import { UsageTable } from './UsageTable.tsx'

const SpendChart = lazy(() => import('./SpendChart.tsx').then(({ SpendChart }) => ({ default: SpendChart })))

type Search = { period: SpendPeriod; from: string; to: string; granularity: SpendGranularity }

const periodLabels: Record<SpendPeriod, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  last_30_days: 'Last 30 days',
  last_90_days: 'Last 90 days',
  custom: 'Custom',
}
const granularityLabels: Record<SpendGranularity, string> = { day: 'Day', week: 'Week', month: 'Month' }
const dimensionLabels: Record<SpendDimension, string> = {
  member: 'Member',
  project: 'Project',
  chat: 'Chat',
  model: 'Model',
}
const workspaceFactorLabels: Record<SpendFactorName, string> = {
  users: 'Users',
  sessionsPerUser: 'Sessions per user',
  turnsPerSession: 'Turns per session',
  requestsPerTurn: 'Requests per turn',
  tokensPerRequest: 'Tokens per request',
  pricePerToken: 'Price per 1M tokens',
}
const personalFactorLabels = { ...workspaceFactorLabels, sessionsPerUser: 'Sessions' }
const workspaceFormula =
  'users × sessions per user × turns per session × requests per turn × tokens per request × price per token'
const personalFormula = workspaceFormula.replace('users × sessions per user', 'sessions')
const cellClass = 'px-2 py-1.5 text-right'
const today = () => new Date().toISOString().slice(0, 10)

const searchOf = ({ period, from, to, granularity }: Search): Record<string, string> =>
  period === 'custom' ? { period, from, to, granularity } : { period, granularity }

const usageRowsOf = (rows: readonly SpendRow[]) => rows.map((row) => ({ ...row, calls: row.requests }))

export const Decomposition = ({
  decomposition,
  isPersonal,
}: {
  decomposition: SpendReport['decomposition']
  isPersonal: boolean
}) => (
  <LabelledSection title="Spend decomposition" Heading="h3" titleClass="font-medium">
    <p className="text-sm text-muted">
      Spend {formatCost(decomposition.current.costMicros)} against {formatCost(decomposition.previous.costMicros)} in
      the previous period (
      {formatChange(
        decomposition.previous.costMicros === 0
          ? null
          : decomposition.current.costMicros / decomposition.previous.costMicros - 1,
      )}
      ): {isPersonal ? personalFormula : workspaceFormula}
    </p>
    <table aria-label="Spend decomposition" className="w-full text-sm">
      <thead className="text-xs text-muted">
        <tr>
          {['Factor', 'This period', 'Previous period', 'Change'].map((title, index) => (
            <th key={title} scope="col" className={`${index === 0 ? 'px-2 py-1.5 text-left' : cellClass} font-medium`}>
              {title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {decomposition.factors
          .filter((factor) => !isPersonal || factor.name !== 'users')
          .map((factor) => {
            const isBiggestMover = factor.name === decomposition.biggestMover
            return (
              <tr
                key={factor.name}
                aria-current={isBiggestMover || undefined}
                className={`border-t border-line ${isBiggestMover ? 'bg-selected font-semibold' : ''}`}
              >
                <th scope="row" className="px-2 py-1.5 text-left font-normal">
                  {(isPersonal ? personalFactorLabels : workspaceFactorLabels)[factor.name]}
                  {isBiggestMover && <span className="ml-1 text-xs text-muted"> · Biggest mover</span>}
                </th>
                <td className={cellClass}>{formatFactor(factor.name, factor.current)}</td>
                <td className={cellClass}>{formatFactor(factor.name, factor.previous)}</td>
                <td className={cellClass}>{formatChange(factor.change)}</td>
              </tr>
            )
          })}
      </tbody>
    </table>
  </LabelledSection>
)

const MergedPulls = ({ mergedPulls }: { mergedPulls: NonNullable<SpendReport['mergedPulls']> }) => (
  <LabelledSection title="Cost per merged PR" Heading="h3" titleClass="font-medium">
    {mergedPulls.perPullMicros === null ? (
      <p className="text-sm text-muted">No pull request merged in this period</p>
    ) : (
      <>
        <p className="text-sm">
          {formatCost(mergedPulls.perPullMicros)} per merged PR · {mergedPulls.pulls.length} merged ·{' '}
          {formatCost(mergedPulls.costMicros)} spent in their chats
        </p>
        <table aria-label="Merged pull requests" className="w-full text-sm">
          <thead className="text-xs text-muted">
            <tr>
              {['Chat', 'Pull request', 'Chat cost'].map((title, index) => (
                <th
                  key={title}
                  scope="col"
                  className={`${index === 2 ? cellClass : 'px-2 py-1.5 text-left'} font-medium`}
                >
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mergedPulls.pulls.map((pull) => (
              <tr key={`${pull.repository}#${pull.number}`} className="border-t border-line">
                <th scope="row" className="px-2 py-1.5 text-left font-normal">
                  {pull.chatName}
                </th>
                <td className="px-2 py-1.5">
                  <a href={pull.url} target="_blank" rel="noreferrer" className="text-link underline">
                    {pull.repository}#{pull.number}
                  </a>{' '}
                  <span className="text-muted">{pull.title}</span>
                </td>
                <td className={cellClass}>{formatCost(pull.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </>
    )}
  </LabelledSection>
)

export const SpendReportView = ({
  title,
  workspaceId,
  readReport,
  chartDimensions,
  tableDimensions,
  children,
  isPersonal = false,
}: {
  children?: ReactNode
  title: string
  workspaceId: WorkspaceId
  readReport: (input: { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }) => Promise<SpendReport>
  chartDimensions: readonly SpendDimension[]
  tableDimensions: readonly SpendDimension[]
  isPersonal?: boolean
}) => {
  const [search, setSearch] = useState<Search>({
    period: 'this_month',
    from: `${today().slice(0, 7)}-01`,
    to: today(),
    granularity: 'day',
  })
  const [stack, setStack] = useState(chartDimensions[0] ?? 'model')
  const [report, setReport] = useState<SpendReport | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    let isCurrent = true
    readReport({ workspaceId, search: searchOf(search) }).then(
      (loaded) => {
        if (!isCurrent) return
        setReport(loaded)
        setLoadError(null)
      },
      (error: Error) => isCurrent && setLoadError(error.message),
    )
    return () => {
      isCurrent = false
    }
  }, [readReport, workspaceId, search])
  const chart = report?.charts[stack]
  return (
    <LabelledSection title={title}>
      {children}
      <fieldset aria-label="Period" className="flex flex-wrap items-end gap-2">
        <label className={labelClass}>
          Period
          <select
            className={fieldClass}
            value={search.period}
            onChange={(event) => setSearch({ ...search, period: event.target.value as SpendPeriod })}
          >
            {spendPeriods.map((period) => (
              <option key={period} value={period}>
                {periodLabels[period]}
              </option>
            ))}
          </select>
        </label>
        {search.period === 'custom' &&
          (['from', 'to'] as const).map((bound) => (
            <label key={bound} className={labelClass}>
              {bound === 'from' ? 'From' : 'To'}
              <input
                type="date"
                className={fieldClass}
                value={search[bound]}
                onChange={(event) => event.target.value && setSearch({ ...search, [bound]: event.target.value })}
              />
            </label>
          ))}
        <SegmentedChoice
          label="Granularity"
          name="granularity"
          options={spendGranularities}
          labels={granularityLabels}
          value={search.granularity}
          onChange={(granularity) => setSearch({ ...search, granularity })}
        />
      </fieldset>
      <ErrorMessage message={loadError} />
      {report === null ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <>
          {report.total.requests === 0 ? (
            <p className="text-sm text-muted">No usage in this period</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm">
                  {formatCost(report.total.costMicros)} · {report.total.requests.toLocaleString('en-US')} requests
                </p>
                <SegmentedChoice
                  label="Stack by"
                  name="stack"
                  options={chartDimensions}
                  labels={dimensionLabels}
                  value={stack}
                  onChange={setStack}
                />
              </div>
              {chart && (
                <Suspense fallback={<p className="text-sm text-muted">Loading the chart…</p>}>
                  <SpendChart
                    chart={chart}
                    granularity={report.granularity}
                    label={`Spend over time by ${dimensionLabels[stack].toLowerCase()}`}
                  />
                </Suspense>
              )}
              {tableDimensions.map((dimension) => (
                <UsageTable
                  key={dimension}
                  label={`Usage by ${dimensionLabels[dimension].toLowerCase()}`}
                  heading={dimensionLabels[dimension]}
                  rows={usageRowsOf(report.tables[dimension] ?? [])}
                  total={{ ...report.total, calls: report.total.requests }}
                  hasShare
                />
              ))}
            </>
          )}
          <Decomposition decomposition={report.decomposition} isPersonal={isPersonal} />
          {report.mergedPulls && <MergedPulls mergedPulls={report.mergedPulls} />}
        </>
      )}
    </LabelledSection>
  )
}
