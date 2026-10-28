import { Content, Portal, Provider, Root, Trigger } from '@radix-ui/react-tooltip'
import { focusRing, tooltipClass } from '@spyria/ui'
import { type ContextSize, contextFullnessOf } from '../domain/context-size.ts'

const radius = 6
const circumference = 2 * Math.PI * radius

export const ContextChip = ({ context }: { context: ContextSize }) => {
  const { percent, isNearlyFull, shown, label } = contextFullnessOf(context)
  return (
    <Provider>
      <Root>
        <Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className={`flex shrink-0 cursor-default items-center gap-1 rounded-md px-2 py-1 text-xs ${focusRing} ${isNearlyFull ? 'text-agent-error' : 'text-muted'}`}
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
        </Trigger>
        <Portal>
          <Content sideOffset={6} className={tooltipClass}>
            {label}
          </Content>
        </Portal>
      </Root>
    </Provider>
  )
}
