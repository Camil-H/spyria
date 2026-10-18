import type { ReactNode } from 'react'

type LabelListRow = { key: string; label: string; value: string }

export const LabelList = ({ rows, empty }: { rows: readonly LabelListRow[]; empty: ReactNode }) =>
  rows.length === 0 ? (
    empty
  ) : (
    <ul className="flex flex-col gap-2 text-sm">
      {rows.map((row) => (
        <li key={row.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span>{row.label}</span>
          <span className="text-xs text-muted">{row.value}</span>
        </li>
      ))}
    </ul>
  )
