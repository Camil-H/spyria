import type { ReactNode } from 'react'

export type StatusTone = 'ok' | 'off' | 'attention'

const dotClasses: Record<StatusTone, string> = {
  ok: 'bg-success',
  off: 'border border-muted',
  attention: 'bg-warning',
}

export const StatusBadge = ({ tone, children }: { tone: StatusTone; children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-muted">
    <span aria-hidden className={`size-2 shrink-0 rounded-full ${dotClasses[tone]}`} />
    {children}
  </span>
)
