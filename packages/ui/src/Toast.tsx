import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'
import { createContext, type ReactNode, use, useState } from 'react'
import { iconButtonClass } from './classes.ts'

type ToastTone = 'success' | 'info' | 'error'

const toneLooks = {
  success: { Icon: CircleCheck, iconClass: 'text-success', barClass: 'bg-success' },
  info: { Icon: Info, iconClass: 'text-link', barClass: 'bg-accent' },
  error: { Icon: CircleAlert, iconClass: 'text-danger', barClass: 'bg-danger' },
} as const

const Toast = ({
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

export type ActionOutcome = { isRefused?: boolean; text: string }
type Notice = ActionOutcome & { id: string }

const shownMilliseconds = 5000

const NotifyContext = createContext<((outcome: ActionOutcome) => void) | null>(null)

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [notice, setNotice] = useState<Notice>()
  const notify = (outcome: ActionOutcome) => setNotice({ ...outcome, id: crypto.randomUUID() })
  return (
    <NotifyContext value={notify}>
      {children}
      <section aria-label="Notifications">
        {notice && (
          <Toast
            key={notice.id}
            tone={notice.isRefused ? 'error' : 'success'}
            dismissAfterMilliseconds={notice.isRefused ? undefined : shownMilliseconds}
            onDismiss={() => setNotice(undefined)}
          >
            {notice.text}
          </Toast>
        )}
      </section>
    </NotifyContext>
  )
}

export const useNotify = () => {
  const notify = use(NotifyContext)
  if (!notify) throw new Error('ToastProvider is missing')
  return notify
}

export const useNotifiedRun = (run: (action: () => Promise<unknown>) => Promise<boolean>) => {
  const notify = useNotify()
  return async (action: () => Promise<unknown>, successText: string) => {
    const isDone = await run(action)
    if (isDone) notify({ text: successText })
    return isDone
  }
}
