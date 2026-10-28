export const shortcutTextOf = (keys: string) =>
  keys
    .split(' ')
    .map((key) => key.toUpperCase())
    .join(' then ')

export const ShortcutKeys = ({ keys }: { keys: string }) => (
  <kbd aria-hidden className="font-sans text-muted">
    {shortcutTextOf(keys)}
  </kbd>
)
