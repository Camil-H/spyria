import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import { Ellipsis } from 'lucide-react'
import { iconButtonClass, menuContentClass, menuItemClass } from './classes.ts'

export type RowMenuItem = { label: string; onSelect: () => void }

export const RowMenu = ({ label, items }: { label: string; items: readonly RowMenuItem[] }) => (
  <Root>
    <Trigger aria-label={label} className={iconButtonClass}>
      <Ellipsis aria-hidden className="size-4" />
    </Trigger>
    <Content align="end" className={menuContentClass}>
      {items.map(({ label: itemLabel, onSelect }) => (
        <Item key={itemLabel} className={menuItemClass} onSelect={onSelect}>
          {itemLabel}
        </Item>
      ))}
    </Content>
  </Root>
)
