const keyNames: Readonly<Record<string, string>> = { escape: 'Esc' }

export const shortcutTextOf = (keys: string) =>
  keys
    .split(' ')
    .map((key) => keyNames[key] ?? key.toUpperCase())
    .join(' then ')

export const ShortcutKeys = ({ keys }: { keys: string }) => (
  <kbd aria-hidden className="font-sans text-muted">
    {shortcutTextOf(keys)}
  </kbd>
)
