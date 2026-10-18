import type { LucideIcon } from 'lucide-react'

export const EmptyState = ({ Icon, title, hint }: { Icon: LucideIcon; title: string; hint: string }) => (
  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
    <Icon aria-hidden strokeWidth={1.5} className="size-8 text-muted" />
    <p className="text-sm font-medium">{title}</p>
    <p className="max-w-64 text-xs text-muted">{hint}</p>
  </div>
)
