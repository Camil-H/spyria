export const SegmentedChoice = <Option extends string>({
  label,
  name,
  options,
  labels,
  value,
  onChange,
}: {
  label?: string
  name: string
  options: readonly Option[]
  labels: Record<Option, string>
  value: Option | null
  onChange: (option: Option) => void
}) => (
  <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg border border-line bg-app p-1">
    {options.map((option) => (
      <label
        key={option}
        className="relative flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1 text-center text-sm text-muted hover:bg-hover hover:text-ink has-checked:bg-selected has-checked:font-medium has-checked:text-ink has-focus-visible:outline-2 has-focus-visible:outline-focus"
      >
        <input
          type="radio"
          className="absolute inset-0 cursor-pointer opacity-0"
          name={name}
          checked={value === option}
          onChange={() => onChange(option)}
        />
        {labels[option]}
      </label>
    ))}
  </div>
)
