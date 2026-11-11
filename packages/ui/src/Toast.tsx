import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { iconButtonClass } from './classes.ts'

type ToastTone = 'success' | 'info' | 'error'

const toneLooks = {
  success: { Icon: CircleCheck, iconClass: 'text-agent-done', barClass: 'bg-agent-done' },
  info: { Icon: Info, iconClass: 'text-link', barClass: 'bg-accent' },
  error: { Icon: CircleAlert, iconClass: 'text-agent-error', barClass: 'bg-agent-error' },
} as const

export const Toast = ({
  children,
  tone = 'info',
  dismissAfterMilliseconds,
  onDismiss,
}: {
  children: ReactNode
  tone?: ToastTone
  dismissAfterMilliseconds?: number
  onDismiss?: () => void
}) => {
  const [isOpen, setIsOpen] = useState(true)
  const dismiss = () => {
    setIsOpen(false)
    onDismiss?.()
  }
  const { Icon, iconClass, barClass } = toneLooks[tone]
  return (
    isOpen && (
      <div
        role={tone === 'error' ? 'alert' : 'status'}
        className="group fixed bottom-6 left-1/2 z-50 flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-start gap-3 overflow-hidden rounded-xl border border-line bg-raised/95 py-2.5 pr-2 pl-3.5 text-sm text-ink shadow-xl ring-1 ring-black/5 backdrop-blur transition duration-300 ease-out sm:max-w-md motion-reduce:transition-none starting:translate-y-3 starting:scale-95 starting:opacity-0 dark:ring-white/5"
      >
        <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${iconClass}`} />
        <p className="py-px leading-5">{children}</p>
        <button type="button" aria-label="Dismiss" className={`-my-0.5 ${iconButtonClass}`} onClick={dismiss}>
          <X aria-hidden className="size-4" />
        </button>
        {dismissAfterMilliseconds !== undefined && (
          <span
            aria-hidden
            className={`absolute inset-x-0 bottom-0 h-0.5 origin-left animate-[toast-countdown_linear_forwards] opacity-60 group-hover:[animation-play-state:paused] group-focus-within:[animation-play-state:paused] motion-reduce:opacity-0 ${barClass}`}
            style={{ animationDuration: `${dismissAfterMilliseconds}ms` }}
            onAnimationEnd={dismiss}
          />
        )}
      </div>
    )
  )
}
