import { fieldClass } from '@spyria/ui'
import type { UsageMonth } from '../domain/usage.ts'
import { formatMonth } from './format.ts'

export const MonthPicker = ({
  months,
  month,
  onChange,
}: {
  months: readonly UsageMonth[]
  month: UsageMonth
  onChange: (month: UsageMonth) => void
}) => (
  <select
    aria-label="Month"
    className={`self-start ${fieldClass}`}
    value={month}
    onChange={(event) => onChange(event.target.value)}
  >
    {months.map((option) => (
      <option key={option} value={option}>
        {formatMonth(option)}
      </option>
    ))}
  </select>
)
