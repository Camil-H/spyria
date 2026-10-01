import type { ReactNode } from 'react'
import { ghostButtonClass } from './ui.ts'

export const Dialog = ({
  label,
  subject,
  onClose,
  children,
}: {
  label: string
  subject?: string
  onClose: () => void
  children: ReactNode
}) => (
  <dialog
    open
    aria-label={label}
    className="fixed inset-0 z-40 m-auto flex h-fit w-80 flex-col gap-3 rounded-xl border border-line bg-raised p-5 text-ink shadow-2xl"
  >
    <h2 className="text-[1rem] font-medium">{label}</h2>
    {subject && <p className="-mt-2 truncate text-sm text-muted">{subject}</p>}
    {children}
    <button type="button" className={ghostButtonClass} onClick={onClose}>
      Cancel
    </button>
  </dialog>
)
