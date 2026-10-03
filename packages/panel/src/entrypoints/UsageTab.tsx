import { useQuery } from '@hq/db/react'
import { getUsage } from '../queries/get-usage.ts'
import type { TabProps } from './TabProps.ts'

const formatCost = (costCents: number) => `$${(costCents / 100).toFixed(2)}`
const cellClass = 'px-2 py-1.5 text-right'

export const UsageTab = ({ workspaceId, chatId }: TabProps) => {
  const { rows, total } = useQuery(getUsage(workspaceId, chatId))
  return (
    <table className="w-full text-sm">
      <thead className="text-xs text-muted">
        <tr>
          <th scope="col" className="px-2 py-1.5 text-left font-medium">
            Member
          </th>
          <th scope="col" className={`${cellClass} font-medium`}>
            Tokens
          </th>
          <th scope="col" className={`${cellClass} font-medium`}>
            Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.memberId} className="border-t border-line">
            <th scope="row" className="px-2 py-1.5 text-left font-normal">
              {row.name}
            </th>
            <td className={cellClass}>{row.tokens.toLocaleString('en-US')}</td>
            <td className={cellClass}>{formatCost(row.costCents)}</td>
          </tr>
        ))}
        <tr className="border-t border-line font-semibold">
          <th scope="row" className="px-2 py-1.5 text-left">
            Total
          </th>
          <td className={cellClass}>{total.tokens.toLocaleString('en-US')}</td>
          <td className={cellClass}>{formatCost(total.costCents)}</td>
        </tr>
      </tbody>
    </table>
  )
}
