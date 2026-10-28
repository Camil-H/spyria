import { fieldClass, focusRing, IconButton } from '@spyria/ui'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'

const focusOnMount = (element: HTMLInputElement | null) => element?.focus()

export const FindBar = ({
  text,
  count,
  position,
  onTextChange,
  onNext,
  onPrevious,
  onSearchEarlier,
  onClose,
}: {
  text: string
  count: number
  position: number
  onTextChange: (text: string) => void
  onNext: () => void
  onPrevious: () => void
  onSearchEarlier: (() => void) | undefined
  onClose: () => void
}) => {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') onClose()
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (event.shiftKey) onPrevious()
    else onNext()
  }
  return (
    <search aria-label="Find in this chat" className="flex items-center gap-1">
      <input
        type="search"
        aria-label="Find in this chat"
        placeholder="Find in this chat"
        className={`${fieldClass} min-w-0 flex-1`}
        value={text}
        ref={focusOnMount}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <output aria-live="polite" className="shrink-0 px-2 text-xs text-muted tabular-nums">
        {text.trim() === '' ? '' : count === 0 ? 'No matches' : `${position} of ${count}`}
      </output>
      <IconButton isSmall label="Previous match" icon={ChevronUp} disabled={count === 0} onClick={onPrevious} />
      <IconButton isSmall label="Next match" icon={ChevronDown} disabled={count === 0} onClick={onNext} />
      {onSearchEarlier && (
        <button
          type="button"
          onClick={onSearchEarlier}
          className={`shrink-0 rounded-full px-2 py-1 text-xs text-muted hover:bg-hover hover:text-ink ${focusRing}`}
        >
          Search earlier messages
        </button>
      )}
      <IconButton isSmall label="Close find" icon={X} onClick={onClose} />
    </search>
  )
}
