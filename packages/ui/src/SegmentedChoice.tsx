export const SegmentedChoice = <Option extends string>({
  label,
  describedBy,
  name,
  options,
  labels,
  value,
  disabledOptions = [],
  onChange,
}: {
  label?: string
  describedBy?: string
  name: string
  options: readonly Option[]
  labels: Record<Option, string>
  value: Option | null
  disabledOptions?: readonly Option[]
  onChange: (option: Option) => void
}) => (
  <div
    role="radiogroup"
    aria-label={label}
    aria-describedby={describedBy}
    className="flex gap-1 rounded-lg border border-line bg-app p-1"
  >
    {options.map((option) => (
      <label
        key={option}
        className="relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1 text-sm text-muted hover:bg-hover hover:text-ink has-checked:bg-selected has-checked:font-medium has-checked:text-ink has-disabled:cursor-not-allowed has-disabled:opacity-50 has-disabled:hover:bg-transparent has-disabled:hover:text-muted has-focus-visible:outline-2 has-focus-visible:outline-focus"
      >
        <input
          type="radio"
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          name={name}
          checked={value === option}
          disabled={disabledOptions.includes(option)}
          onChange={() => onChange(option)}
        />
        {labels[option]}
      </label>
    ))}
  </div>
)
