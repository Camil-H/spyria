import { expect, test } from 'bun:test'
import { chatId, messageId, workspaceId } from '@spyria/kernel'
import { alice } from './mock-data.ts'
import { createSnapshotBuilder, createZeroStore, windowMessagesIn } from './zero-store.ts'

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
  const first = snapshotFrom(build, { ...workspaceRows, chatMessages: messages })
  expect(snapshotFrom(build, { ...workspaceRows, chatMessages: messages })).toBe(first)
  const readMarkers = [{ ...workspaceRows.readMarkers[0], lastReadSeq: 2 }]
  const afterRead = snapshotFrom(build, { ...workspaceRows, chatMessages: messages, readMarkers })
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
  const first = snapshotFrom(build, { ...workspaceRows, chatMessages: [prompt, answer, other] })
  expect(first.messages.map(({ id, body }) => [id, body])).toEqual([
    ['message-1', 'Body 1'],
    ['message-2', 'Body 2'],
    ['message-3', 'Body 3'],
  ])
  expect(Object.getOwnPropertySymbols(first.messages[0])).toEqual([])
  expect(first.messages[0]?.createdAt).toBe('2026-10-01T09:01:00.000Z')
  const edited = { ...answer, body: 'Edited answer', editedAt: Date.UTC(2026, 9, 1, 10) }
  const late = messageOf(4, { replyToId: 'message-1' })
  const second = snapshotFrom(build, { ...workspaceRows, chatMessages: [prompt, edited, late] })
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
  expect(snapshotFrom(build, { ...workspaceRows, chatMessages: messages }).messages.map(({ id }) => id)).toEqual([
    messageId('message-1'),
    messageId('message-3'),
    messageId('message-2'),
  ])
  const withAnswer = [...messages, messageOf(4, { replyToId: 'message-2' })]
  expect(snapshotFrom(build, { ...workspaceRows, chatMessages: withAnswer }).messages.map(({ id }) => id)).toEqual([
    messageId('message-1'),
    messageId('message-3'),
    messageId('message-2'),
    messageId('message-4'),
  ])
})

test('the latest messages, pinned steps, page bodies and usage of the watched queries reach their snapshot fields', () => {
  const build = createSnapshotBuilder(alice)
  const usageOf = (month: string, costMicros: number) =>
    zeroRowOf({
      workspaceId: 'workspace-acme',
      chatId: 'chat-research',
      month,
      userId: alice,
      tokens: 1,
      costMicros,
      calls: 1,
    })
  const page = zeroRowOf({
    workspaceId: 'workspace-acme',
    chatId: 'chat-research',
    url: 'u',
    title: 't',
    bodyText: 'Body',
  })
  const snapshot = snapshotFrom(build, {
    ...workspaceRows,
    latestMessages: [messageOf(7)],
    chatPinnedSteps: [messageOf(3, { replyToId: 'message-1', body: 'plan' })],
    chatBrowserPages: [page],
    chatUsage: [usageOf('2026-09', 10), usageOf('2026-10', 20)],
    monthUsage: [usageOf('2026-10', 20)],
  })
  expect(snapshot.messages).toEqual([])
  expect(snapshot.latestMessages.map(({ id, createdAt }) => [id, createdAt])).toEqual([
    ['message-7', '2026-10-01T09:07:00.000Z'],
  ])
  expect(snapshot.pinnedSteps.map(({ id, body }) => [id, body])).toEqual([['message-3', 'plan']])
  expect(snapshot.browserPages.map(({ bodyText }) => bodyText)).toEqual(['Body'])
  expect(snapshot.usageEntries.map(({ month, memberId, costMicros }) => [month, memberId, costMicros])).toEqual([
    ['2026-09', alice, 10],
    ['2026-10', alice, 20],
  ])
})

test('a chat window lists each shown root once with its replies and thread replies, without the nested lists', () => {
  const seed = { ...messageOf(1, { replyToId: 'message-1' }), kind: 'member' }
  const answer = messageOf(2, { replyToId: 'message-1' })
  const threadReply = { ...messageOf(4), threadRootId: 'message-3' }
  const roots = [
    { ...messageOf(3), replies: [], threadReplies: [threadReply] },
    { ...seed, replies: [seed, answer], threadReplies: [] },
  ]
  const window = windowMessagesIn(roots)
  expect(window.map((message) => (message as { id: string }).id)).toEqual([
    'message-3',
    'message-4',
    'message-1',
    'message-2',
  ])
  expect(window.some((message) => 'replies' in message || 'threadReplies' in message)).toBe(false)
  expect(windowMessagesIn(roots)[0]).toBe(window[0])
  expect(window[3]).toBe(answer)
})

test('a workspace whose zero-cache answers nothing reports every materialized query as pending with its connection state, and nothing once closed', async () => {
  const store = createZeroStore({
    memberId: alice,
    sessions: [{ workspaceId: workspaceId('workspace-acme'), token: 'token', expiresAt: Date.now() + 60_000 }],
    renew: async () => undefined,
    cacheURL: 'http://localhost:1',
    kvStore: 'mem',
  })
  const { cacheURL, workspaces } = store.diagnostics()
  expect(cacheURL).toBe('http://localhost:1')
  const acme = workspaces['workspace-acme']
  expect(acme?.pending).toContain('workspaces')
  expect(acme?.pending).toContain('memberships')
  expect(typeof acme?.state).toBe('object')
  expect(typeof acme?.clientID).toBe('string')
  await store.close()
  const closed = store.diagnostics()
  expect(closed.workspaces['workspace-acme']).toMatchObject({ state: 'closed', pending: [], clientID: acme?.clientID })
  expect(closed.connectionEvents.map(({ event }) => event)).toContain('closed by the store')
})
