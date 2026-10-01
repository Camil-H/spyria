import type { Snapshot } from './schema.ts'

export type Store = ReturnType<typeof createStore>

export const createStore = (initialSnapshot: Snapshot) => {
  let snapshot = initialSnapshot
  const listeners = new Set<() => void>()
  return {
    read: () => snapshot,
    write: (updater: (current: Snapshot) => Snapshot) => {
      const nextSnapshot = updater(snapshot)
      if (nextSnapshot === snapshot) return
      snapshot = nextSnapshot
      for (const listener of listeners) listener()
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
