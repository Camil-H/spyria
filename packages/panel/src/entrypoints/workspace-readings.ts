import type { WorkspaceReading } from '../domain/workspace.ts'

export type KeptReading = { version: string; value: WorkspaceReading }

const maximumUnwatchedReadings = 30

export const createWorkspaceReadings = () => {
  const kept = new Map<string, KeptReading>()
  const refreshCounts = new Map<string, number>()
  const watchCounts = new Map<string, number>()
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const evictUnwatched = () => {
    const unwatched = [...kept.keys()].filter((key) => !watchCounts.has(key))
    for (const oldest of unwatched.slice(0, -maximumUnwatchedReadings)) kept.delete(oldest)
  }
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    watch: (key: string) => {
      watchCounts.set(key, (watchCounts.get(key) ?? 0) + 1)
      return () => {
        const count = (watchCounts.get(key) ?? 1) - 1
        if (count > 0) watchCounts.set(key, count)
        else watchCounts.delete(key)
        evictUnwatched()
      }
    },
    keptOf: (key: string) => kept.get(key),
    refreshCountOf: (key: string) => refreshCounts.get(key) ?? 0,
    keep: (key: string, reading: KeptReading) => {
      kept.delete(key)
      kept.set(key, reading)
      evictUnwatched()
      notify()
    },
    refresh: (key: string) => {
      refreshCounts.set(key, (refreshCounts.get(key) ?? 0) + 1)
      notify()
    },
  }
}

export type WorkspaceReadings = ReturnType<typeof createWorkspaceReadings>
