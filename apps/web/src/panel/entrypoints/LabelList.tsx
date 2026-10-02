import { emptyClass } from './ui.ts'

type LabelListRow = { key: string; label: string; value: string }

export const LabelList = ({ rows, emptyMessage }: { rows: readonly LabelListRow[]; emptyMessage: string }) =>
  rows.length === 0 ? (
    <p className={emptyClass}>{emptyMessage}</p>
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
