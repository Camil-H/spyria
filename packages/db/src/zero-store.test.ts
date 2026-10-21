import { expect, test } from 'bun:test'
import { chatId, messageId, workspaceId } from '@spyria/kernel'
import { alice } from './mock-data.ts'
import { createSnapshotBuilder, createZeroStore } from './zero-store.ts'

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
    'spyria.draft:member-alice:workspace-acme:chat-shared-id',
    'spyria.draft:member-alice:workspace-globex:chat-shared-id',
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

const zeroRowSymbol = Symbol('zero-ref-count')
const zeroRowOf = <Row extends object>(row: Row) => ({ ...row, [zeroRowSymbol]: 1 })
const messageOf = (seq: number, fields: { replyToId?: string; body?: string } = {}) =>
  zeroRowOf({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    id: `message-${seq}`,
    seq,
    kind: fields.replyToId ? 'agent' : 'member',
    authorId: fields.replyToId ? null : alice,
    body: fields.body ?? `Body ${seq}`,
    detail: null,
    step: null,
    replyToId: fields.replyToId ?? null,
    threadRootId: null,
    createdAt: Date.UTC(2026, 9, 1, 9, seq),
    editedAt: null,
    deletedAt: null,
  })
const workspaceRows = {
  workspaces: [zeroRowOf({ workspaceId: 'workspace-acme', name: 'Acme', localSessions: true })],
  readMarkers: [zeroRowOf({ workspaceId: 'workspace-acme', userId: alice, chatId: 'chat-research', lastReadSeq: 1 })],
}
const noDrafts = [] as const
const snapshotFrom = (build: ReturnType<typeof createSnapshotBuilder>, rows: object) => build([rows as never], noDrafts)

test('a change rebuilds only its table: other tables keep their identity, and no change keeps the snapshot', () => {
  const build = createSnapshotBuilder(alice)
  const messages = [messageOf(1), messageOf(2, { replyToId: 'message-1' })]
  const first = snapshotFrom(build, { ...workspaceRows, messages })
  expect(snapshotFrom(build, { ...workspaceRows, messages })).toBe(first)
  const readMarkers = [{ ...workspaceRows.readMarkers[0], lastReadSeq: 2 }]
  const afterRead = snapshotFrom(build, { ...workspaceRows, messages, readMarkers })
  expect(afterRead).not.toBe(first)
  expect(afterRead.readMarkers).toEqual([
    { workspaceId: workspaceId('workspace-acme'), memberId: alice, chatId: chatId('chat-research'), lastReadSeq: 2 },
  ])
  expect(afterRead.messages).toBe(first.messages)
  expect(afterRead.workspaces).toBe(first.workspaces)
  expect(afterRead.memberships).toBe(first.memberships)
})

test('a messages change shows inserts, updates and deletes, keeps unchanged rows and strips Zero’s own fields', () => {
  const build = createSnapshotBuilder(alice)
  const [prompt, answer, other] = [messageOf(1), messageOf(2, { replyToId: 'message-1' }), messageOf(3)]
  const first = snapshotFrom(build, { ...workspaceRows, messages: [prompt, answer, other] })
  expect(first.messages.map(({ id, body }) => [id, body])).toEqual([
    ['message-1', 'Body 1'],
    ['message-2', 'Body 2'],
    ['message-3', 'Body 3'],
  ])
  expect(Object.getOwnPropertySymbols(first.messages[0])).toEqual([])
  expect(first.messages[0]?.createdAt).toBe('2026-10-01T09:01:00.000Z')
  const edited = { ...answer, body: 'Edited answer', editedAt: Date.UTC(2026, 9, 1, 10) }
  const late = messageOf(4, { replyToId: 'message-1' })
  const second = snapshotFrom(build, { ...workspaceRows, messages: [prompt, edited, late] })
  expect(second.messages.map(({ id, body, editedAt }) => [id, body, editedAt])).toEqual([
    ['message-1', 'Body 1', null],
    ['message-2', 'Edited answer', '2026-10-01T10:00:00.000Z'],
    ['message-4', 'Body 4', null],
  ])
  expect(second.messages[0]).toBe(first.messages[0])
  expect(second.readMarkers).toBe(first.readMarkers)
})

test('a reply sorts under its prompt even when a later prompt came between them', () => {
  const build = createSnapshotBuilder(alice)
  const messages = [messageOf(1), messageOf(2), messageOf(3, { replyToId: 'message-1' })]
  expect(snapshotFrom(build, { ...workspaceRows, messages }).messages.map(({ id }) => id)).toEqual([
    messageId('message-1'),
    messageId('message-3'),
    messageId('message-2'),
  ])
  const withAnswer = [...messages, messageOf(4, { replyToId: 'message-2' })]
  expect(snapshotFrom(build, { ...workspaceRows, messages: withAnswer }).messages.map(({ id }) => id)).toEqual([
    messageId('message-1'),
    messageId('message-3'),
    messageId('message-2'),
    messageId('message-4'),
  ])
})
