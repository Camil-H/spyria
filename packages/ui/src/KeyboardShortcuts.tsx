import { useState } from 'react'
import { Dialog } from './Dialog.tsx'
import { ShortcutLabel } from './ShortcutLabel.tsx'
import { useShortcut, useShortcuts } from './shortcuts.ts'

const kbdClass = 'min-w-6 rounded border border-line bg-app px-1.5 py-0.5 text-center font-sans text-xs text-ink'

const KeySequence = ({ keys }: { keys: string }) => (
  <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
    {keys.split(' ').map((key, index) => (
      <span key={key} className="flex items-center gap-1">
        {index > 0 && ' then '}
        <kbd className={kbdClass}>{key.toUpperCase()}</kbd>
      </span>
    ))}
  </span>
)

export const KeyboardShortcuts = () => {
  const [isOpen, setIsOpen] = useState(false)
  const shortcuts = useShortcuts()
  useShortcut('?', 'Keyboard shortcuts', () => setIsOpen(true))
  if (!isOpen) return null
  const listed = [...new Map(shortcuts.map((shortcut) => [shortcut.keys, shortcut])).values()]
  return (
    <Dialog label="Keyboard shortcuts" closeLabel="Close" isWide onClose={() => setIsOpen(false)}>
      <ul aria-label="Keyboard shortcuts" className="-mx-2 flex flex-col overflow-y-auto">
        {listed.map(({ keys, label }) => (
          <li key={keys} className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-sm">
            <span>
              <ShortcutLabel label={label} shortcut={keys.split(' ')[0] ?? keys} />
            </span>
            <KeySequence keys={keys} />
          </li>
        ))}
      </ul>
    </Dialog>
  )
}
