import { Content, Portal, Root, Trigger } from '@radix-ui/react-tooltip'
import { iconButtonClass, tooltipClass } from '@spyria/ui'
import type { LucideIcon } from 'lucide-react'

export const IconButton = ({
  label,
  icon: Icon,
  onClick,
}: {
  label: string
  icon: LucideIcon
  onClick: () => void
}) => (
  <Root>
    <Trigger type="button" aria-label={label} className={iconButtonClass} onClick={onClick}>
      <Icon size={18} />
    </Trigger>
    <Portal>
      <Content sideOffset={6} className={tooltipClass}>
        {label}
      </Content>
    </Portal>
  </Root>
)
