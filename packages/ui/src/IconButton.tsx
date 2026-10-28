import { Content, Portal, Root, Trigger } from '@radix-ui/react-tooltip'
import type { LucideIcon } from 'lucide-react'
import { iconButtonClass, tooltipClass } from './classes.ts'
import { ShortcutKeys } from './ShortcutKeys.tsx'

export const IconButton = ({
  label,
  icon: Icon,
  shortcut,
  isSmall = false,
  disabled = false,
  tabIndex,
  onClick,
}: {
  label: string
  icon: LucideIcon
  shortcut?: string
  isSmall?: boolean
  disabled?: boolean
  tabIndex?: number
  onClick: () => void
}) => (
  <Root>
    <Trigger
      type="button"
      aria-label={label}
      aria-keyshortcuts={shortcut?.toUpperCase()}
      disabled={disabled}
      tabIndex={tabIndex}
      className={`${iconButtonClass} ${isSmall ? 'p-1' : ''} disabled:cursor-not-allowed disabled:opacity-40`}
      onClick={onClick}
    >
      <Icon aria-hidden size={isSmall ? 16 : 18} />
    </Trigger>
    <Portal>
      <Content sideOffset={6} className={tooltipClass}>
        {label}
        {shortcut && (
          <>
            {' '}
            <ShortcutKeys keys={shortcut} />
          </>
        )}
      </Content>
    </Portal>
  </Root>
)
