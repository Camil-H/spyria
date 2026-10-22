import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { iconButtonClass } from './classes.ts'

export const Toast = ({ children }: { children: ReactNode }) => {
  const [isOpen, setIsOpen] = useState(true)
  return (
    isOpen && (
      <div
        role="status"
        className="fixed bottom-4 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-line bg-raised py-2 pr-2 pl-4 text-sm text-ink shadow-lg"
      >
        <p>{children}</p>
        <button type="button" aria-label="Dismiss" className={iconButtonClass} onClick={() => setIsOpen(false)}>
          <X aria-hidden className="size-4" />
        </button>
      </div>
    )
  )
}
