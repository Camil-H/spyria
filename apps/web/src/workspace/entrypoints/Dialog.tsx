import type { ReactNode } from 'react'

export const Dialog = ({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) => (
  <dialog open aria-label={label}>
    {children}
    <button type="button" onClick={onClose}>
      Cancel
    </button>
  </dialog>
)
