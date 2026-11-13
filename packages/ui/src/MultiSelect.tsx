import { CheckboxItem, Content, ItemIndicator, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown } from 'lucide-react'
import { fieldClass, menuContentClass, menuItemClass } from './classes.ts'

export type MultiSelectOption = { value: string; label: string }

export const MultiSelect = ({
  label,
  summary,
  options,
  values,
  onChange,
}: {
  label: string
  summary: string
  options: readonly MultiSelectOption[]
  values: readonly string[]
  onChange: (values: string[]) => void
}) => (
  <Root modal={false}>
    <Trigger aria-label={label} className={`${fieldClass} inline-flex items-center gap-2`}>
      {summary}
      <ChevronDown aria-hidden className="size-4 text-muted" />
    </Trigger>
    <Content align="start" className={`${menuContentClass} max-h-72 overflow-y-auto`}>
      {options.map((option) => (
        <CheckboxItem
          key={option.value}
          className={`${menuItemClass} justify-start gap-2`}
          checked={values.includes(option.value)}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(isChecked) =>
            onChange(isChecked ? [...values, option.value] : values.filter((value) => value !== option.value))
          }
        >
          <span className="flex size-4 shrink-0 items-center justify-center rounded border border-line">
            <ItemIndicator>
              <Check aria-hidden className="size-3" />
            </ItemIndicator>
          </span>
          {option.label}
        </CheckboxItem>
      ))}
    </Content>
  </Root>
)
