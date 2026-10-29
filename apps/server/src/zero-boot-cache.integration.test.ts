import { afterAll, expect, test } from 'bun:test'
import { createZeroStore } from '@spyria/db/zero-store'
import { acme, alice, openSharedTestApp, waitFor, zeroSessionsOf } from './testing/testing.ts'

const { zeroCacheUrl } = await openSharedTestApp()
const unreachableCacheUrl = 'http://127.0.0.1:1'
const storageKeyPrefix = `${crypto.randomUUID()}:`
const syncedTablesKey = `spyria.synced-tables:${alice}:${storageKeyPrefix}${acme}`
const openedStores: { close: () => Promise<unknown> }[] = []
const syncedTables = new Map<string, string>()

const storageOf = (items: Map<string, string>): Storage => ({
  get length() {
    return items.size
  },
  key: (index) => [...items.keys()][index] ?? null,
  getItem: (key) => items.get(key) ?? null,
  setItem: (key, value) => void items.set(key, value),
  removeItem: (key) => void items.delete(key),
  clear: () => items.clear(),
})
const openStore = async (cacheURL: string, syncedTables: Map<string, string>) => {
  const store = createZeroStore({
    memberId: alice,
    sessions: await zeroSessionsOf(alice, [acme]),
    renew: async () => undefined,
    cacheURL,
    kvStore: 'mem',
    storageKeyPrefix,
    syncedTablesStorage: storageOf(syncedTables),
  })
  openedStores.push(store)
  return store
}
const isReadableWithin = (store: Awaited<ReturnType<typeof openStore>>, milliseconds: number) =>
  Promise.race([
    store.whenReadable(acme).then((outcome) => outcome === 'readable'),
    Bun.sleep(milliseconds).then(() => false),
  ])
const syncedTablesWithout = (table: string | null) => {
  const tables: string[] = JSON.parse(syncedTables.get(syncedTablesKey) ?? '[]')
  return new Map([[syncedTablesKey, JSON.stringify(tables.filter((synced) => synced !== table))]])
}

const synced = await openStore(zeroCacheUrl, syncedTables)
await synced.whenLoaded(acme)
await waitFor(
  async () => isReadableWithin(await openStore(unreachableCacheUrl, syncedTablesWithout(null)), 200),
  15_000,
)
afterAll(() => Promise.all(openedStores.map((store) => store.close())))

test('a full sync records every table it synced for the member and the workspace', () => {
  expect(JSON.parse(syncedTables.get(syncedTablesKey) ?? '[]')).toContain('llmCredentials')
})

test('a store opened offline on a synced cache is readable at once with every table the synced store had, yet not loaded', async () => {
  const offline = await openStore(unreachableCacheUrl, syncedTablesWithout(null))
  expect(await isReadableWithin(offline, 2_000)).toBe(true)
  expect(offline.read()).toEqual(synced.read())
  expect(offline.isLoaded(acme)).toBe(false)
})

test('a cache that lacks a table the app reads, or has no record, waits for the full sync', async () => {
  expect(await isReadableWithin(await openStore(unreachableCacheUrl, syncedTablesWithout('llmCredentials')), 500)).toBe(
    false,
  )
  expect(await isReadableWithin(await openStore(unreachableCacheUrl, new Map()), 500)).toBe(false)
})

test('closing a workspace that never became readable ends the wait for it as closed, so opening the app does not wait without end', async () => {
  const unsynced = await openStore(unreachableCacheUrl, new Map())
  const readable = unsynced.whenReadable(acme)
  await unsynced.close()
  expect(await readable).toBe('closed')
})
