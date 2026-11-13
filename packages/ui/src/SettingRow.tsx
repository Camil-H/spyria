import type { ReactNode } from 'react'
import { rowClass } from './classes.ts'

export const SettingRow = ({
  title,
  description,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
}) => (
  <div className={rowClass}>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="font-medium">{title}</span>
      {description && <span className="text-muted">{description}</span>}
    </span>
    {children && <span className="flex items-center gap-2">{children}</span>}
  </div>
)
