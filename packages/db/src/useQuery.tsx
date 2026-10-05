import { createContext, type ReactNode, use, useRef, useSyncExternalStore } from 'react'
import type { Snapshot } from './schema.ts'
import type { Store } from './zero-store.ts'

const isContainer = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const replaceEqualDeep = <Value,>(previous: unknown, next: Value): Value => {
  if (Object.is(previous, next) || !isContainer(previous) || !isContainer(next)) return next
  if (Array.isArray(previous) !== Array.isArray(next)) return next
  const nextKeys = Object.keys(next)
  const merged = (Array.isArray(next) ? [] : {}) as Record<string, unknown>
  for (const key of nextKeys) merged[key] = replaceEqualDeep(previous[key], next[key])
  const isUnchanged =
    nextKeys.length === Object.keys(previous).length && nextKeys.every((key) => merged[key] === previous[key])
  return (isUnchanged ? previous : merged) as Value
}

const StoreContext = createContext<Store | null>(null)

export const StoreProvider = ({ store, children }: { store: Store; children: ReactNode }) => (
  <StoreContext value={store}>{children}</StoreContext>
)

export const useStore = () => {
  const store = use(StoreContext)
  if (!store) throw new Error('StoreProvider is missing')
  return store
}

export const useQuery = <Result,>(query: (snapshot: Snapshot) => Result): Result => {
  const store = useStore()
  const memo = useRef<{ snapshot: Snapshot; query: typeof query; value: Result } | null>(null)
  return useSyncExternalStore(store.subscribe, () => {
    const snapshot = store.read()
    const previous = memo.current
    if (previous?.snapshot === snapshot && previous.query === query) return previous.value
    const value = previous ? replaceEqualDeep(previous.value, query(snapshot)) : query(snapshot)
    memo.current = { snapshot, query, value }
    return value
  })
}
