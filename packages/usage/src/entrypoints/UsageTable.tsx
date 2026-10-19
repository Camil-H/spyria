import { formatCost, formatTokens } from '@spyria/ui'
import type { UsageTotals } from '../domain/usage.ts'

type UsageRow = UsageTotals & { key: string; name: string; share?: number }

const cellClass = 'px-2 py-1.5 text-right'
export const formatShare = (share: number) => `${Math.round(share * 100)}%`

const Cells = ({ totals, share }: { totals: UsageTotals; share?: number }) => (
  <>
    <td className={cellClass}>{formatTokens(totals.tokens)}</td>
    <td className={cellClass}>{formatCost(totals.costMicros)}</td>
    <td className={cellClass}>{formatTokens(totals.calls)}</td>
    {share !== undefined && <td className={cellClass}>{formatShare(share)}</td>}
  </>
)

export const UsageTable = ({
  label,
  heading,
  rows,
  total,
  hasShare = false,
}: {
  label: string
  heading: string
  rows: readonly UsageRow[]
  total: UsageTotals
  hasShare?: boolean
}) => (
  <table aria-label={label} className="w-full text-sm">
    <thead className="text-xs text-muted">
      <tr>
        {[heading, 'Tokens', 'Cost', 'Requests', ...(hasShare ? ['Share'] : [])].map((title, index) => (
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
          <Cells totals={row} share={hasShare ? (row.share ?? 0) : undefined} />
        </tr>
      ))}
      <tr className="border-t border-line font-semibold">
        <th scope="row" className="px-2 py-1.5 text-left">
          Total
        </th>
        <Cells totals={total} share={hasShare ? 1 : undefined} />
      </tr>
    </tbody>
  </table>
)
