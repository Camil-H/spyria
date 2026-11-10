import type { WorkspaceReading } from '../domain/workspace.ts'

export type KeptReading = { version: string; value: WorkspaceReading }

const maximumKeptReadings = 30

export const createWorkspaceReadings = () => {
  const kept = new Map<string, KeptReading>()
  const refreshCounts = new Map<string, number>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    keptOf: (key: string) => kept.get(key),
    refreshCountOf: (key: string) => refreshCounts.get(key) ?? 0,
    keep: (key: string, reading: KeptReading) => {
      kept.delete(key)
      kept.set(key, reading)
      for (const oldest of [...kept.keys()].slice(0, -maximumKeptReadings)) kept.delete(oldest)
      notify()
    },
    refresh: (key: string) => {
      refreshCounts.set(key, (refreshCounts.get(key) ?? 0) + 1)
      notify()
    },
  }
}

export type WorkspaceReadings = ReturnType<typeof createWorkspaceReadings>
