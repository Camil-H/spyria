import type { ChatId, WorkspaceId } from '@spyria/kernel'
import { createContext, type ReactNode, use, useEffect, useState, useSyncExternalStore } from 'react'
import type { Snapshot } from './schema.ts'
import type { ScopedQueryName, Store } from './zero-store.ts'

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

type Query<Args extends readonly unknown[], Result> = (...args: Args) => (snapshot: Snapshot) => Result

const isSameArgs = (previous: readonly unknown[], next: readonly unknown[]) =>
  previous.length === next.length && previous.every((arg, index) => Object.is(arg, next[index]))

export const createQueryCache = () => {
  let previous: { snapshot: Snapshot; query: unknown; args: readonly unknown[]; value: unknown } | undefined
  return <Args extends readonly unknown[], Result>(snapshot: Snapshot, query: Query<Args, Result>, args: Args) => {
    if (previous?.snapshot === snapshot && previous.query === query && isSameArgs(previous.args, args))
      return previous.value as Result
    const next = query(...args)(snapshot)
    const value = previous ? replaceEqualDeep(previous.value, next) : next
    previous = { snapshot, query, args, value }
    return value
  }
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

export const useQuery = <Args extends readonly unknown[], Result>(
  query: Query<Args, Result>,
  ...args: Args
): Result => {
  const store = useStore()
  const [readQuery] = useState(createQueryCache)
  return useSyncExternalStore(store.subscribe, () => readQuery(store.read(), query, args))
}

export const useScoped = (
  workspaceId: WorkspaceId,
  name: ScopedQueryName,
  args: Record<string, string | number> | null,
) => {
  const store = useStore()
  const key = args && JSON.stringify(args)
  useEffect(() => (key ? store.watch(workspaceId, name, JSON.parse(key)) : undefined), [store, workspaceId, name, key])
  return useSyncExternalStore(store.subscribe, () => (args ? store.scopedStatus(workspaceId, name, args) : undefined))
}

export const chatPageSize = 50

const oldestSeqOf = (roots: readonly object[]) => Math.min(...roots.map((root) => (root as { seq: number }).seq))

export const useChatMessages = (workspaceId: WorkspaceId, chatId: ChatId) => {
  const [shown, setShown] = useState({ chatId, limit: chatPageSize, oldestSeq: Number.POSITIVE_INFINITY })
  const limit = shown.chatId === chatId ? shown.limit : chatPageSize
  const roots = useScoped(workspaceId, 'chatMessages', { chatId, limit })
  useScoped(workspaceId, 'chatPinnedSteps', { chatId })
  const hasEarlier = roots?.rows.length === limit
  const oldestSeq = roots?.isComplete && roots.rows.length > 0 ? oldestSeqOf(roots.rows) : undefined
  if (shown.chatId !== chatId) setShown({ chatId, limit, oldestSeq: Number.POSITIVE_INFINITY })
  else if (oldestSeq !== undefined && oldestSeq !== shown.oldestSeq)
    setShown(
      hasEarlier && oldestSeq > shown.oldestSeq ? { ...shown, limit: limit + chatPageSize } : { ...shown, oldestSeq },
    )
  return {
    isComplete: roots?.isComplete === true,
    hasEarlier,
    loadEarlier: () => setShown({ ...shown, chatId, limit: limit + chatPageSize }),
  }
}
