import { rowClass } from '@spyria/ui'
import type { ReactNode } from 'react'
import { RowMenu, type RowMenuItem } from './RowMenu.tsx'

export const ConnectionRow = ({
  label,
  name,
  status,
  action,
  menuItems,
  children,
}: {
  label: string
  name: string
  status: ReactNode
  action?: ReactNode
  menuItems: readonly RowMenuItem[]
  children?: ReactNode
}) => (
  <li aria-label={label} className={rowClass}>
    <span className="w-40 truncate font-medium">{name}</span>
    {status}
    <span className="ml-auto flex items-center gap-2">
      {action}
      {menuItems.length > 0 && <RowMenu label={`Actions for ${name}`} items={menuItems} />}
    </span>
    {children}
  </li>
)
