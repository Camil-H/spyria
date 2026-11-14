import type { WorkspaceId } from '@spyria/kernel'
import {
  calloutClass,
  ErrorMessage,
  fieldClass,
  focusRing,
  formatCost,
  ghostButtonClass,
  LabelledSection,
  labelClass,
  MultiSelect,
  SegmentedChoice,
} from '@spyria/ui'
import { ChevronRight } from 'lucide-react'
import { Fragment, lazy, type ReactNode, Suspense, useEffect, useId, useState } from 'react'
import { costHistogramOf, mergedPullsCsvOf } from '../domain/merged-pulls.ts'
import {
  factorValuesOf,
  type SpendBucketCounts,
  type SpendDimension,
  type SpendFactorName,
  type SpendGranularity,
  type SpendPeriod,
  type SpendReport,
  type SpendRow,
  scopeKeysParameterOf,
  spendGranularities,
  spendPeriods,
} from '../domain/spend.ts'
import { formatChange, formatFactor } from './format.ts'
import { UsageTable } from './UsageTable.tsx'

const SpendChart = lazy(() => import('./SpendChart.tsx').then(({ SpendChart }) => ({ default: SpendChart })))
const TrendChart = lazy(() => import('./TrendChart.tsx').then(({ TrendChart }) => ({ default: TrendChart })))
const CostHistogram = lazy(() =>
  import('./CostHistogram.tsx').then(({ CostHistogram }) => ({ default: CostHistogram })),
)

type Scope = { scope: SpendDimension | ''; scopeKeys: string[] }
type Search = Scope & { period: SpendPeriod; from: string; to: string; granularity: SpendGranularity }

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
const cellClass = 'px-2 py-1.5 text-right'
const operatorClass = 'w-4 py-1.5 pl-2 text-center text-muted'
const today = () => new Date().toISOString().slice(0, 10)

const noScope: Scope = { scope: '', scopeKeys: [] }
const isScoped = ({ scope, scopeKeys }: Scope) => scope !== '' && scopeKeys.length > 0
const searchOf = ({ period, from, to, granularity, scope, scopeKeys }: Search): Record<string, string> => ({
  ...(period === 'custom' ? { period, from, to, granularity } : { period, granularity }),
  ...(isScoped({ scope, scopeKeys }) && { scope, scopeKeys: scopeKeysParameterOf(scopeKeys) }),
})

const usageRowsOf = (rows: readonly SpendRow[]) => rows.map((row) => ({ ...row, calls: row.requests }))

type DecompositionRow = SpendFactorName | 'total'
type ReadTrend = (input: {
  workspaceId: WorkspaceId
  search: Readonly<Record<string, string>>
}) => Promise<SpendBucketCounts[]>
type Trend = { key: string; counts: SpendBucketCounts[] | null; error: string | null }

const trendPointsOf = (counts: readonly SpendBucketCounts[], row: DecompositionRow) =>
  counts.map((bucketCounts) => ({
    bucket: bucketCounts.bucket,
    value: row === 'total' ? bucketCounts.costMicros : factorValuesOf(bucketCounts)[row],
  }))
const formatRowValue = (row: DecompositionRow) => (value: number | null) =>
  row !== 'total' ? formatFactor(row, value) : value === null ? '—' : formatCost(value)

const RowToggle = ({ label, isOpen, controls }: { label: string; isOpen: boolean; controls: string }) => (
  <button
    type="button"
    aria-expanded={isOpen}
    aria-controls={isOpen ? controls : undefined}
    className={`inline-flex items-center gap-1 rounded-md text-left ${focusRing} aria-expanded:[&>svg]:rotate-90`}
  >
    {label}
    <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted transition-transform" />
  </button>
)

const toggleRowClass = 'cursor-pointer hover:bg-hover'

export const Decomposition = ({
  decomposition,
  isPersonal,
  granularity,
  workspaceId,
  trendKey,
  readTrend,
}: {
  decomposition: SpendReport['decomposition']
  isPersonal: boolean
  granularity: SpendGranularity
  workspaceId: WorkspaceId
  trendKey: string
  readTrend: ReadTrend
}) => {
  const chartIdPrefix = useId()
  const [openRow, setOpenRow] = useState<DecompositionRow | null>(null)
  const [trend, setTrend] = useState<Trend | null>(null)
  const isOpen = openRow !== null
  const isTrendCurrent = trend?.key === trendKey
  useEffect(() => {
    if (!isOpen || isTrendCurrent) return
    let isCurrent = true
    readTrend({ workspaceId, search: JSON.parse(trendKey) }).then(
      (counts) => isCurrent && setTrend({ key: trendKey, counts, error: null }),
      (error: Error) => isCurrent && setTrend({ key: trendKey, counts: null, error: error.message }),
    )
    return () => {
      isCurrent = false
    }
  }, [isOpen, isTrendCurrent, readTrend, workspaceId, trendKey])
  const factorLabels = isPersonal ? personalFactorLabels : workspaceFactorLabels
  const toggle = (row: DecompositionRow) => setOpenRow(openRow === row ? null : row)
  const chartIdOf = (row: DecompositionRow) => `${chartIdPrefix}-${row}`
  const chartRowOf = (row: DecompositionRow, label: string) =>
    openRow === row && (
      <tr id={chartIdOf(row)}>
        <td colSpan={5} className="px-2 pt-1 pb-3">
          {!isTrendCurrent ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : trend.counts === null ? (
            <ErrorMessage message={trend.error} />
          ) : (
            <Suspense fallback={<p className="text-sm text-muted">Loading the chart…</p>}>
              <TrendChart
                points={trendPointsOf(trend.counts, row)}
                granularity={granularity}
                formatValue={formatRowValue(row)}
                label={`${label} over time`}
              />
            </Suspense>
          )}
        </td>
      </tr>
    )
  return (
    <LabelledSection title="Spend decomposition" Heading="h3" titleClass="font-medium">
      <table aria-label="Spend decomposition" className="w-full text-sm">
        <thead className="text-xs text-muted">
          <tr>
            <td aria-hidden className={operatorClass} />
            {['Factor', 'This period', 'Previous period', 'Change'].map((title, index) => (
              <th
                key={title}
                scope="col"
                className={`${index === 0 ? 'px-2 py-1.5 text-left' : cellClass} font-medium`}
              >
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {decomposition.factors
            .filter((factor) => !isPersonal || factor.name !== 'users')
            .map((factor, index) => {
              const isBiggestMover = factor.name === decomposition.biggestMover
              const label = factorLabels[factor.name]
              return (
                <Fragment key={factor.name}>
                  <tr
                    aria-current={isBiggestMover || undefined}
                    onClick={() => toggle(factor.name)}
                    className={`border-t border-line ${toggleRowClass} ${isBiggestMover ? 'bg-selected font-semibold' : ''}`}
                  >
                    <td aria-hidden className={operatorClass}>
                      {index > 0 && '×'}
                    </td>
                    <th scope="row" className="px-2 py-1.5 text-left font-normal">
                      <RowToggle label={label} isOpen={openRow === factor.name} controls={chartIdOf(factor.name)} />
                      {isBiggestMover && <span className="ml-1 text-xs text-muted"> · Biggest mover</span>}
                    </th>
                    <td className={cellClass}>{formatFactor(factor.name, factor.current)}</td>
                    <td className={cellClass}>{formatFactor(factor.name, factor.previous)}</td>
                    <td className={cellClass}>{formatChange(factor.change)}</td>
                  </tr>
                  {chartRowOf(factor.name, label)}
                </Fragment>
              )
            })}
          <tr onClick={() => toggle('total')} className={`border-t border-line font-semibold ${toggleRowClass}`}>
            <td aria-hidden className={operatorClass}>
              =
            </td>
            <th scope="row" className="px-2 py-1.5 text-left">
              <RowToggle label="Total spend" isOpen={openRow === 'total'} controls={chartIdOf('total')} />
            </th>
            <td className={cellClass}>{formatCost(decomposition.current.costMicros)}</td>
            <td className={cellClass}>{formatCost(decomposition.previous.costMicros)}</td>
            <td className={cellClass}>
              {formatChange(
                decomposition.previous.costMicros === 0
                  ? null
                  : decomposition.current.costMicros / decomposition.previous.costMicros - 1,
              )}
            </td>
          </tr>
          {chartRowOf('total', 'Total spend')}
        </tbody>
      </table>
    </LabelledSection>
  )
}

const downloadCsv = (fileName: string, csv: string) => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = Object.assign(document.createElement('a'), { href: url, download: fileName })
  link.click()
  URL.revokeObjectURL(url)
}

const MergedPulls = ({
  mergedPulls,
  granularity,
  period,
  isScoped,
  isPersonal,
}: {
  mergedPulls: SpendReport['mergedPulls']
  granularity: SpendGranularity
  period: { from: string; to: string }
  isScoped: boolean
  isPersonal: boolean
}) => (
  <LabelledSection title="Cost per merged PR" Heading="h3" titleClass="font-medium">
    {isPersonal && (
      <p className="text-sm text-muted">
        The pull requests merged from chats you prompted in, against what you spent in those chats
      </p>
    )}
    {isScoped && (
      <p className="text-sm text-muted">
        {isPersonal
          ? 'Counted over all your usage, whatever it is narrowed to'
          : 'Counted over the whole workspace, whatever the usage is narrowed to'}
      </p>
    )}
    {mergedPulls.perPullMicros === null ? (
      <p className="text-sm text-muted">No pull request merged in this period</p>
    ) : (
      <>
        <p className="text-sm">
          {formatCost(mergedPulls.perPullMicros)} per merged PR · {mergedPulls.pulls.length} merged ·{' '}
          {formatCost(mergedPulls.costMicros)} {isPersonal ? 'you spent' : 'spent'} in their chats
        </p>
        <Suspense fallback={<p className="text-sm text-muted">Loading the charts…</p>}>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted">Average cost per merged PR</h4>
              <TrendChart
                points={mergedPulls.trend.map(({ bucket, perPullMicros }) => ({ bucket, value: perPullMicros }))}
                granularity={granularity}
                formatValue={(value) => (value === null ? '—' : formatCost(value))}
                label="Average cost per merged PR over time"
              />
            </div>
            <div className="flex flex-col gap-1">
              <h4 className="text-xs font-medium text-muted">Merged PRs by cost</h4>
              <CostHistogram
                bins={costHistogramOf(mergedPulls.pulls.map((pull) => pull.costMicros))}
                label="Merged PRs by chat cost"
              />
            </div>
          </div>
        </Suspense>
        <button
          type="button"
          className={`self-start ${ghostButtonClass}`}
          onClick={() =>
            downloadCsv(
              `merged-prs-${period.from.slice(0, 10)}-${period.to.slice(0, 10)}.csv`,
              mergedPullsCsvOf(mergedPulls.pulls),
            )
          }
        >
          Export data
        </button>
      </>
    )}
  </LabelledSection>
)

const scopeSummaryOf = (
  rows: SpendReport['scopeChoices'][SpendDimension],
  dimension: SpendDimension,
  keys: readonly string[],
) => {
  const chosen = (rows ?? []).filter((row) => keys.includes(row.key))
  if (chosen.length === 0) return `Choose ${dimensionLabels[dimension].toLowerCase()}s`
  return chosen.length === 1 ? (chosen[0]?.name ?? '') : `${chosen.length} ${dimensionLabels[dimension].toLowerCase()}s`
}

const ScopePicker = ({
  choices,
  dimensions,
  isPersonal,
  value,
  onChange,
}: {
  choices: SpendReport['scopeChoices']
  dimensions: readonly SpendDimension[]
  isPersonal: boolean
  value: Scope
  onChange: (scope: Scope) => void
}) => {
  const dimension = value.scope
  const rows = dimension ? (choices[dimension] ?? []) : []
  return (
    <>
      <select
        aria-label="Narrow to"
        className={fieldClass}
        value={dimension}
        onChange={(event) => {
          const picked = event.target.value as SpendDimension | ''
          const firstRow = picked ? choices[picked]?.[0] : undefined
          onChange(firstRow ? { scope: picked, scopeKeys: [firstRow.key] } : noScope)
        }}
      >
        <option value="">{isPersonal ? 'All my usage' : 'Whole workspace'}</option>
        {dimensions.map((choice) => (
          <option key={choice} value={choice} disabled={(choices[choice] ?? []).length === 0}>
            {dimensionLabels[choice]}
          </option>
        ))}
      </select>
      {dimension && (
        <MultiSelect
          label={dimensionLabels[dimension]}
          summary={scopeSummaryOf(rows, dimension, value.scopeKeys)}
          options={rows.map((row) => ({ value: row.key, label: row.name }))}
          values={value.scopeKeys}
          onChange={(scopeKeys) => onChange(scopeKeys.length > 0 ? { scope: dimension, scopeKeys } : noScope)}
        />
      )}
    </>
  )
}

export const SpendReportView = ({
  title,
  workspaceId,
  readReport,
  readTrend,
  chartDimensions,
  tableDimensions,
  children,
  isPersonal = false,
}: {
  children?: ReactNode
  title: string
  workspaceId: WorkspaceId
  readReport: (input: { workspaceId: WorkspaceId; search: Readonly<Record<string, string>> }) => Promise<SpendReport>
  readTrend: ReadTrend
  chartDimensions: readonly SpendDimension[]
  tableDimensions: readonly SpendDimension[]
  isPersonal?: boolean
}) => {
  const [search, setSearch] = useState<Search>({
    period: 'this_month',
    from: `${today().slice(0, 7)}-01`,
    to: today(),
    granularity: 'day',
    ...noScope,
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
      <p className={calloutClass}>
        Sessions run on a member's own machine (Claude Code, Codex) use their own subscription and are not counted here.
      </p>
      {children}
      <fieldset aria-label="Filters" className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Period"
          className={fieldClass}
          value={search.period}
          onChange={(event) => setSearch({ ...search, period: event.target.value as SpendPeriod, ...noScope })}
        >
          {spendPeriods.map((period) => (
            <option key={period} value={period}>
              {periodLabels[period]}
            </option>
          ))}
        </select>
        {search.period === 'custom' &&
          (['from', 'to'] as const).map((bound) => (
            <label key={bound} className={labelClass}>
              {bound === 'from' ? 'From' : 'To'}
              <input
                type="date"
                className={fieldClass}
                value={search[bound]}
                onChange={(event) =>
                  event.target.value && setSearch({ ...search, [bound]: event.target.value, ...noScope })
                }
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
        {report && (
          <ScopePicker
            choices={report.scopeChoices}
            dimensions={tableDimensions}
            isPersonal={isPersonal}
            value={search}
            onChange={(scope) => setSearch({ ...search, ...scope })}
          />
        )}
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
                <p className="text-sm text-muted">
                  <span className="text-2xl font-semibold text-ink">{formatCost(report.total.costMicros)}</span> ·{' '}
                  {report.total.requests.toLocaleString('en-US')} requests
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
          <Decomposition
            decomposition={report.decomposition}
            isPersonal={isPersonal}
            granularity={search.granularity}
            workspaceId={workspaceId}
            trendKey={JSON.stringify(searchOf(search))}
            readTrend={readTrend}
          />
          <MergedPulls
            mergedPulls={report.mergedPulls}
            granularity={report.granularity}
            period={report}
            isScoped={isScoped(search)}
            isPersonal={isPersonal}
          />
        </>
      )}
    </LabelledSection>
  )
}
