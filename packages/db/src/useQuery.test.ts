import { expect, test } from 'bun:test'
import { chatId, workspaceId } from '@spyria/kernel'
import { alice, createMockSnapshot } from './mock-data.ts'
import type { DraftRow, Snapshot } from './schema.ts'
import { createQueryCache } from './useQuery.tsx'

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
