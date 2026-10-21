import { expect, test } from 'bun:test'
import { createMockSnapshot } from './mock-data.ts'
import type { Snapshot } from './schema.ts'
import { createQueryCache } from './useQuery.tsx'

const runs: string[] = []
const chatNamesIn = (workspaceId: string) => (snapshot: Snapshot) => {
  runs.push(workspaceId)
  return snapshot.chats.filter((chat) => chat.workspaceId === workspaceId).map((chat) => ({ name: chat.name }))
}

test('a query reruns only when the snapshot or its arguments change, and keeps equal results', () => {
  runs.length = 0
  const readQuery = createQueryCache()
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
