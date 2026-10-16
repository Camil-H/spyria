import { expect, test } from 'bun:test'
import { chatId, workspaceId } from '@hq/kernel'
import { alice } from './mock-data.ts'
import { createZeroStore } from './zero-store.ts'

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
const storeOn = (items: Map<string, string>) =>
  createZeroStore({
    memberId: alice,
    sessions: [],
    renew: async () => undefined,
    cacheURL: 'http://localhost:1',
    draftStorage: storageOf(items),
  })
const draftIn = (workspace: string, text: string) => ({
  workspaceId: workspaceId(workspace),
  chatId: chatId('chat-shared-id'),
  memberId: alice,
  text,
})

test('keeps the drafts of the same chat id in two workspaces apart and stores each at once', async () => {
  const items = new Map<string, string>()
  const store = storeOn(items)
  store.replaceDraft(draftIn('workspace-acme', 'In Acme'))
  store.replaceDraft(draftIn('workspace-globex', 'In Globex'))
  expect([...items.keys()]).toEqual([
    'hq.draft:member-alice:workspace-acme:chat-shared-id',
    'hq.draft:member-alice:workspace-globex:chat-shared-id',
  ])
  await Promise.resolve()
  expect(store.read().drafts).toEqual([draftIn('workspace-acme', 'In Acme'), draftIn('workspace-globex', 'In Globex')])
  expect(storeOn(items).read().drafts).toEqual(store.read().drafts)
})

test('an empty draft removes the stored one', () => {
  const items = new Map<string, string>()
  const store = storeOn(items)
  store.replaceDraft(draftIn('workspace-acme', 'In Acme'))
  store.replaceDraft(draftIn('workspace-acme', ''))
  expect(items.size).toBe(0)
  expect(storeOn(items).read().drafts).toEqual([])
})
