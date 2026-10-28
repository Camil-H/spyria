import { expect, test } from 'bun:test'
import { snapshotReadingOf } from './workspace-reads.ts'

test('a snapshot gives each branch read its part, and a snapshot older than the commits read gives it the changes, which held the log', () => {
  const snapshot = JSON.stringify({
    tree: { entries: [] },
    changes: { patch: 'p' },
    commits: { log: 'l' },
    status: { uncommitted: 0 },
  })
  expect(snapshotReadingOf(snapshot, 'tree', '')).toEqual({ entries: [] })
  expect(snapshotReadingOf(snapshot, 'tree', 'src')).toBeUndefined()
  expect(snapshotReadingOf(snapshot, 'changes', '')).toEqual({ patch: 'p' })
  expect(snapshotReadingOf(snapshot, 'commits', '')).toEqual({ log: 'l' })
  expect(snapshotReadingOf(snapshot, 'status', '')).toEqual({ uncommitted: 0 })
  expect(snapshotReadingOf(snapshot, 'file', 'README.md')).toBeUndefined()
  const olderSnapshot = JSON.stringify({ changes: { patch: 'p', log: 'l' } })
  expect(snapshotReadingOf(olderSnapshot, 'commits', '')).toEqual({ patch: 'p', log: 'l' })
  expect(snapshotReadingOf(undefined, 'commits', '')).toBeUndefined()
})
