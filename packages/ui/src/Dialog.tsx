import { type ReactNode, useEffect } from 'react'
import { ghostButtonClass } from './classes.ts'

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
}) => {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return (
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
}
