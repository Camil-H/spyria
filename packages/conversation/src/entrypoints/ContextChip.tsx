import {
  Item,
  Label,
  Content as MenuContent,
  Root as MenuRoot,
  Trigger as MenuTrigger,
} from '@radix-ui/react-dropdown-menu'
import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { ErrorMessage, focusRing, menuContentClass, menuItemClass, tooltipClass, useGuardedAction } from '@spyria/ui'
import type { ReactNode } from 'react'
import { type ContextSize, contextFullnessOf } from '../domain/context-size.ts'

const radius = 6
const circumference = 2 * Math.PI * radius

export type CompactAction = { compact: () => Promise<unknown>; isAgentWorking: boolean }

export const ContextChip = ({ context, compactAction }: { context: ContextSize; compactAction?: CompactAction }) => {
  const { percent, isNearlyFull, shown, label } = contextFullnessOf(context)
  const { errorMessage, isPending, run } = useGuardedAction()
  const button = (
    <button
      type="button"
      aria-label={label}
      className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs ${compactAction ? 'hover:bg-hover' : 'cursor-default'} ${focusRing} ${isNearlyFull ? 'text-danger' : 'text-muted'}`}
    >
      <svg aria-hidden viewBox="0 0 16 16" width={14} height={14} className="-rotate-90">
        <circle cx={8} cy={8} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
        <circle
          cx={8}
          cy={8}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeDasharray={`${((percent ?? 0) / 100) * circumference} ${circumference}`}
        />
      </svg>
      <span>{shown}</span>
    </button>
  )
  const withTooltip = (trigger: ReactNode) => (
    <Provider>
      <Root>
        <Trigger asChild>{trigger}</Trigger>
        <Portal>
          <Content sideOffset={6} className={tooltipClass}>
            {label}
          </Content>
        </Portal>
      </Root>
    </Provider>
  )
  if (!compactAction) return withTooltip(button)
  return (
    <div className="flex items-center gap-2">
      <MenuRoot>
        {withTooltip(<MenuTrigger asChild>{button}</MenuTrigger>)}
        <MenuContent align="end" side="top" className={`${menuContentClass} max-w-72`}>
          <Label className="px-2 py-1.5 text-xs text-muted">
            Compacting summarizes the earlier conversation so the agent has room to keep working.
          </Label>
          <Item
            className={menuItemClass}
            disabled={compactAction.isAgentWorking || isPending}
            onSelect={() => run(compactAction.compact)}
          >
            Compact the conversation
          </Item>
        </MenuContent>
      </MenuRoot>
      <ErrorMessage message={errorMessage} />
    </div>
  )
}
