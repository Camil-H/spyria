import type { ReactNode } from 'react'
import { ghostButtonClass } from './classes.ts'

const showModal = (dialog: HTMLDialogElement | null) => {
  if (!dialog || dialog.open) return
  dialog.showModal()
  dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus({ focusVisible: true })
}

export const Dialog = ({
  label,
  subject,
  closeLabel = 'Cancel',
  isWide = false,
  onClose,
  children,
}: {
  label: string
  subject?: string
  closeLabel?: string
  isWide?: boolean
  onClose: () => void
  children: ReactNode
}) => (
  <dialog
    ref={showModal}
    aria-label={label}
    onClose={onClose}
    onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }}
    className={`fixed inset-0 z-40 m-auto flex h-fit max-h-[calc(100vh-4rem)] ${isWide ? 'w-[min(36rem,calc(100vw-2rem))]' : 'w-80'} flex-col gap-3 rounded-xl border border-line bg-raised p-5 text-ink shadow-2xl backdrop:bg-black/40`}
  >
    <h2 className="text-[1rem] font-medium">{label}</h2>
    {subject && <p className="-mt-2 truncate text-sm text-muted">{subject}</p>}
    {children}
    <button type="button" className={ghostButtonClass} onClick={onClose}>
      {closeLabel}
    </button>
  </dialog>
)
