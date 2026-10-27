export const shortcutIndexIn = (label: string, shortcut: string) => {
  const words = label.toLowerCase().split(' ')
  const wordIndex = words.findIndex((word) => word.startsWith(shortcut.toLowerCase()))
  return wordIndex < 0 ? -1 : words.slice(0, wordIndex).join(' ').length + (wordIndex > 0 ? 1 : 0)
}

export const ShortcutLabel = ({ label, shortcut }: { label: string; shortcut: string }) => {
  const index = shortcutIndexIn(label, shortcut)
  if (index < 0) return label
  return (
    <>
      {label.slice(0, index)}
      <strong className="font-semibold">{label.slice(index, index + shortcut.length)}</strong>
      {label.slice(index + shortcut.length)}
    </>
  )
}
