import { Content, Item, Root, Trigger } from '@radix-ui/react-dropdown-menu'
import {
  Content as TooltipContent,
  Portal as TooltipPortal,
  Root as TooltipRoot,
  Trigger as TooltipTrigger,
} from '@radix-ui/react-tooltip'
import {
  ErrorMessage,
  focusRing,
  iconButtonClass,
  menuContentClass,
  menuItemClass,
  Spinner,
  tooltipClass,
  useGuardedAction,
} from '@spyria/ui'
import { GitFork } from 'lucide-react'

export type ForkAction = { branch: string | null; fork: (keepsBranch: boolean) => Promise<unknown> }

const chipClass = `flex w-fit items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60 ${focusRing}`

export const ForkButton = ({ action: { branch, fork }, isIcon = false }: { action: ForkAction; isIcon?: boolean }) => {
  const { errorMessage, isPending, run } = useGuardedAction()
  const label = isPending ? 'Forking…' : 'Fork into my session'
  const button = (
    <button
      type="button"
      aria-label={isIcon ? label : undefined}
      disabled={isPending}
      onClick={branch === null ? () => run(() => fork(false)) : undefined}
      className={isIcon ? `${iconButtonClass} disabled:cursor-not-allowed disabled:opacity-40` : chipClass}
    >
      {isPending ? <Spinner /> : <GitFork aria-hidden size={isIcon ? 18 : 12} />}
      {!isIcon && label}
    </button>
  )
  const trigger = branch === null ? button : <Trigger asChild>{button}</Trigger>
  const withTooltip = isIcon ? (
    <TooltipRoot>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipPortal>
        <TooltipContent sideOffset={6} className={tooltipClass}>
          {label}
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  ) : (
    trigger
  )
  return (
    <div className="flex items-center gap-2">
      {branch === null ? (
        withTooltip
      ) : (
        <Root>
          {withTooltip}
          <Content align="end" className={menuContentClass}>
            <Item className={menuItemClass} onSelect={() => run(() => fork(true))}>
              Keep branch {branch}
            </Item>
            <Item className={menuItemClass} onSelect={() => run(() => fork(false))}>
              New branch from {branch}
            </Item>
          </Content>
        </Root>
      )}
      <ErrorMessage message={errorMessage} />
    </div>
  )
}
