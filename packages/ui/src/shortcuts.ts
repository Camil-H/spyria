import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'

export type Shortcut = Readonly<{ keys: string; label: string; run: () => void }>

const chordMilliseconds = 500
const typingSelector = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
const openOverlaySelector = 'dialog[open], [role="dialog"], [role="menu"], [role="listbox"]'

let shortcuts: readonly Shortcut[] = []
let pendingChord: { prefix: string; timer: ReturnType<typeof setTimeout> } | undefined
const listeners = new Set<() => void>()

const shortcutOf = (keys: string) => shortcuts.findLast((shortcut) => shortcut.keys === keys)
const startsChord = (key: string) => shortcuts.some((shortcut) => shortcut.keys.startsWith(`${key} `))

const isIgnored = (event: KeyboardEvent) =>
  event.defaultPrevented ||
  event.ctrlKey ||
  event.metaKey ||
  event.altKey ||
  event.isComposing ||
  (event.target instanceof Element && event.target.closest(typingSelector) !== null) ||
  document.querySelector(openOverlaySelector) !== null

export const shortcutKeyOf = (event: Pick<KeyboardEvent, 'key'>) => event.key.toLowerCase()

const runDeferred = (prefix: string) => {
  pendingChord = undefined
  shortcutOf(prefix)?.run()
}

const handleKeyDown = (event: KeyboardEvent) => {
  if (isIgnored(event)) return
  const key = shortcutKeyOf(event)
  if (pendingChord) {
    const { prefix, timer } = pendingChord
    clearTimeout(timer)
    const chord = shortcutOf(`${prefix} ${key}`)
    if (chord) {
      pendingChord = undefined
      event.preventDefault()
      return chord.run()
    }
    runDeferred(prefix)
  }
  if (startsChord(key)) {
    event.preventDefault()
    pendingChord = { prefix: key, timer: setTimeout(runDeferred, chordMilliseconds, key) }
    return
  }
  const shortcut = shortcutOf(key)
  if (!shortcut) return
  event.preventDefault()
  shortcut.run()
}

const publish = (next: readonly Shortcut[]) => {
  shortcuts = next
  if (shortcuts.length === 1) document.addEventListener('keydown', handleKeyDown)
  if (shortcuts.length === 0) document.removeEventListener('keydown', handleKeyDown)
  for (const listener of listeners) listener()
}

export const registerShortcut = (shortcut: Shortcut) => {
  publish([...shortcuts, shortcut])
  return () => publish(shortcuts.filter((registered) => registered !== shortcut))
}

export const useShortcut = (keys: string, label: string, run: () => void, isEnabled = true) => {
  const onRun = useEffectEvent(run)
  useEffect(
    () => (isEnabled ? registerShortcut({ keys, label, run: () => onRun() }) : undefined),
    [keys, label, isEnabled],
  )
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useShortcuts = () => useSyncExternalStore(subscribe, () => shortcuts)
