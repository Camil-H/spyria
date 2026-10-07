import type { UsageTotals } from '../domain/usage.ts'
import { formatCost, formatTokens } from './format.ts'

type UsageRow = UsageTotals & { key: string; name: string }

const cellClass = 'px-2 py-1.5 text-right'

const Cells = ({ totals }: { totals: UsageTotals }) => (
  <>
    <td className={cellClass}>{formatTokens(totals.tokens)}</td>
    <td className={cellClass}>{formatCost(totals.costMicros)}</td>
    <td className={cellClass}>{formatTokens(totals.calls)}</td>
  </>
)

export const UsageTable = ({
  label,
  heading,
  rows,
  total,
}: {
  label: string
  heading: string
  rows: readonly UsageRow[]
  total: UsageTotals
}) => (
  <table aria-label={label} className="w-full text-sm">
    <thead className="text-xs text-muted">
      <tr>
        {[heading, 'Tokens', 'Cost', 'Calls'].map((title, index) => (
          <th key={title} scope="col" className={`${index === 0 ? 'px-2 py-1.5 text-left' : cellClass} font-medium`}>
            {title}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr key={row.key} className="border-t border-line">
          <th scope="row" className="px-2 py-1.5 text-left font-normal">
            {row.name}
          </th>
          <Cells totals={row} />
        </tr>
      ))}
      <tr className="border-t border-line font-semibold">
        <th scope="row" className="px-2 py-1.5 text-left">
          Total
        </th>
        <Cells totals={total} />
      </tr>
    </tbody>
  </table>
)
