import { createContext, type ReactNode, use, useRef, useSyncExternalStore } from 'react'
import type { Snapshot } from './schema.ts'
import type { Store } from './store.ts'

const isDeepEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || typeof right !== 'object' || !left || !right) return false
  const leftKeys = Object.keys(left)
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) =>
      isDeepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    )
  )
}

const StoreContext = createContext<Store | null>(null)

export const StoreProvider = ({ store, children }: { store: Store; children: ReactNode }) => (
  <StoreContext value={store}>{children}</StoreContext>
)

export const useQuery = <Result,>(query: (snapshot: Snapshot) => Result): Result => {
  const store = use(StoreContext)
  if (!store) throw new Error('StoreProvider is missing')
  const memo = useRef<{ snapshot: Snapshot; query: typeof query; value: Result } | null>(null)
  return useSyncExternalStore(store.subscribe, () => {
    const snapshot = store.read()
    const previous = memo.current
    if (previous?.snapshot === snapshot && previous.query === query) return previous.value
    const nextValue = query(snapshot)
    const value = previous && isDeepEqual(previous.value, nextValue) ? previous.value : nextValue
    memo.current = { snapshot, query, value }
    return value
  })
}
