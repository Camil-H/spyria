import type { ReactNode } from 'react'
import { ghostButtonClass } from './ui.ts'

export const Dialog = ({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) => (
  <dialog
    open
    aria-label={label}
    className="fixed inset-0 z-40 m-auto flex h-fit w-80 flex-col gap-3 rounded-xl border border-line bg-raised p-5 text-ink shadow-2xl"
  >
    {children}
    <button type="button" className={ghostButtonClass} onClick={onClose}>
      Cancel
    </button>
  </dialog>
)
