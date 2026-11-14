import { expect, test } from 'bun:test'
import { chatId, workspaceId } from '@spyria/kernel'
import { alice, createMockSnapshot } from './mock-data.ts'
import type { DraftRow, Snapshot } from './schema.ts'
import { createQueryCache, hasChatWindowOf, openingSinceOf } from './useQuery.tsx'

const runs: string[] = []
const chatNamesIn = (workspaceId: string) => (snapshot: Snapshot) => {
  runs.push(workspaceId)
  return snapshot.chats.filter((chat) => chat.workspaceId === workspaceId).map((chat) => ({ name: chat.name }))
}

test('a query reruns only when the snapshot or its arguments change, and keeps equal results', () => {
  runs.length = 0
  const readQuery = createQueryCache<Snapshot>()
  const snapshot = createMockSnapshot()
  const first = readQuery(snapshot, chatNamesIn, ['workspace-acme'])
  expect(readQuery(snapshot, chatNamesIn, ['workspace-acme'])).toBe(first)
  expect(runs).toEqual(['workspace-acme'])
  const globex = readQuery(snapshot, chatNamesIn, ['workspace-globex'])
  expect(globex).not.toEqual(first)
  expect(runs).toEqual(['workspace-acme', 'workspace-globex'])
  expect(readQuery({ ...snapshot }, chatNamesIn, ['workspace-globex'])).toBe(globex)
  expect(runs).toEqual(['workspace-acme', 'workspace-globex', 'workspace-globex'])
})

test('a draft query that builds a new object on each run keeps its result while the drafts are equal', () => {
  const readQuery = createQueryCache<readonly DraftRow[]>()
  const draftTextsOf = (shownChatId: string) => (drafts: readonly DraftRow[]) => ({
    texts: drafts.filter((draft) => draft.chatId === shownChatId).map((draft) => draft.text),
  })
  const draft = {
    workspaceId: workspaceId('workspace-acme'),
    chatId: chatId('chat-research'),
    memberId: alice,
    text: 'Hi',
  }
  const drafts = [draft]
  const first = readQuery(drafts, draftTextsOf, ['chat-research'])
  expect(readQuery(drafts, draftTextsOf, ['chat-research'])).toBe(first)
  expect(readQuery([...drafts], draftTextsOf, ['chat-research'])).toBe(first)
  expect(readQuery([{ ...draft, text: 'Hello' }], draftTextsOf, ['chat-research'])).toEqual({
    texts: ['Hello'],
  })
})

test('a chat opens on the week before now, from the start of that hour so the window stays the same while switching chats', () => {
  const now = Date.parse('2026-11-10T20:42:17.123Z')
  expect(new Date(openingSinceOf(now)).toISOString()).toBe('2026-11-03T20:00:00.000Z')
  expect(openingSinceOf(Date.parse('2026-11-10T20:59:59.999Z'))).toBe(openingSinceOf(now))
})

test('a chat shows its window once zero-cache answers, while its last answered window is kept, or once it has shown one', () => {
  expect(hasChatWindowOf(undefined, false)).toBe(false)
  expect(hasChatWindowOf({ isComplete: false, rows: [] }, false)).toBe(false)
  expect(hasChatWindowOf({ isComplete: true, rows: [] }, false)).toBe(true)
  expect(hasChatWindowOf({ isComplete: false, isLastComplete: true, rows: [] }, false)).toBe(true)
  expect(hasChatWindowOf({ isComplete: false, rows: [] }, true)).toBe(true)
})
