import { expect, test } from 'bun:test'
import { changeMarkOf, codeFenceOf, commitsOf, fileChangesOf, treeEntriesOf } from './workspace.ts'

const patch = `diff --git a/README.md b/README.md
index 1a2b3c4..5d6e7f8 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
 # acme app
-Old line
+New line
\\ No newline at end of file
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const added = 1
+export const twice = 2
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3e75765..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..aaaaaaa
Binary files /dev/null and b/logo.png differ
`

test('a patch becomes one change per file with its status, counts and diff lines', () => {
  expect(fileChangesOf(patch)).toEqual([
    {
      path: 'README.md',
      status: 'Modified',
      additions: 1,
      deletions: 1,
      lines: [
        { kind: 'context', text: '@@ -1,2 +1,2 @@' },
        { kind: 'context', text: '# acme app' },
        { kind: 'removed', text: 'Old line' },
        { kind: 'added', text: 'New line' },
      ],
    },
    {
      path: 'src/new.ts',
      status: 'Added',
      additions: 2,
      deletions: 0,
      lines: [
        { kind: 'context', text: '@@ -0,0 +1,2 @@' },
        { kind: 'added', text: 'export const added = 1' },
        { kind: 'added', text: 'export const twice = 2' },
      ],
    },
    {
      path: 'old.txt',
      status: 'Deleted',
      additions: 0,
      deletions: 1,
      lines: [
        { kind: 'context', text: '@@ -1 +0,0 @@' },
        { kind: 'removed', text: 'gone' },
      ],
    },
    { path: 'logo.png', status: 'Added', additions: 0, deletions: 0, lines: [] },
  ])
  expect(fileChangesOf('')).toEqual([])
  expect(fileChangesOf(undefined)).toEqual([])
})

test('a git log becomes commits with a short sha', () => {
  expect(
    commitsOf(
      'a1b2c3d4e5f6\x1fFix the totals\x1fPi Agent\x1f2026-10-18T13:20:00+02:00\nb2c3d4e5f6a7\x1fAdd tax\x1fAlice\x1f2026-10-18T10:00:00+00:00\n',
    ),
  ).toEqual([
    { sha: 'a1b2c3d', subject: 'Fix the totals', author: 'Pi Agent', committedAt: '2026-10-18T11:20:00.000Z' },
    { sha: 'b2c3d4e', subject: 'Add tax', author: 'Alice', committedAt: '2026-10-18T10:00:00.000Z' },
  ])
  expect(commitsOf('')).toEqual([])
  expect(commitsOf('c3d4e5f6a7b8\x1fNo date')).toEqual([
    { sha: 'c3d4e5f', subject: 'No date', author: '', committedAt: '' },
  ])
})

test('tree entries are marked by their change, folders when they contain one', () => {
  const changes = fileChangesOf(patch)
  const entries = treeEntriesOf({
    isLive: true,
    entries: [
      { name: 'src', path: 'src', isFolder: true },
      { name: 'docs', path: 'docs', isFolder: true },
      { name: 'README.md', path: 'README.md', isFolder: false },
      { name: 'package.json', path: 'package.json', isFolder: false },
    ],
  })
  expect(entries.map((entry) => changeMarkOf(entry, changes))).toEqual([
    'Contains changes',
    undefined,
    'Modified',
    undefined,
  ])
  expect(changeMarkOf({ name: 'sr', path: 'sr', isFolder: true }, changes)).toBeUndefined()
  expect(treeEntriesOf({ isLive: false })).toEqual([])
})

test('a file shows in a code fence longer than any backtick run it holds, tagged by its extension', () => {
  expect(codeFenceOf('src/app.ts', 'const a = 1')).toBe('```ts\nconst a = 1\n```')
  expect(codeFenceOf('README.md', 'Use ```ts blocks``````')).toBe('```````md\nUse ```ts blocks``````\n```````')
})
