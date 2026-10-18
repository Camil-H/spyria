import { expect, test } from 'bun:test'
import {
  branchStatusOf,
  branchStatusPartsOf,
  changeMarkOf,
  codeFenceOf,
  commitsOf,
  conflictPromptOf,
  type FileChange,
  fileChangesOf,
  isCollapsedByDefault,
  splitRowsOf,
  treeEntriesOf,
} from './workspace.ts'

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

test('a patch becomes one change per file with its status, counts and diff lines numbered on both sides', () => {
  expect(fileChangesOf(patch)).toEqual([
    {
      path: 'README.md',
      status: 'Modified',
      additions: 1,
      deletions: 1,
      lines: [
        { kind: 'hunk', text: '@@ -1,2 +1,2 @@', oldNumber: null, newNumber: null },
        { kind: 'context', text: '# acme app', oldNumber: 1, newNumber: 1 },
        { kind: 'removed', text: 'Old line', oldNumber: 2, newNumber: null },
        { kind: 'added', text: 'New line', oldNumber: null, newNumber: 2 },
      ],
    },
    {
      path: 'src/new.ts',
      status: 'Added',
      additions: 2,
      deletions: 0,
      lines: [
        { kind: 'hunk', text: '@@ -0,0 +1,2 @@', oldNumber: null, newNumber: null },
        { kind: 'added', text: 'export const added = 1', oldNumber: null, newNumber: 1 },
        { kind: 'added', text: 'export const twice = 2', oldNumber: null, newNumber: 2 },
      ],
    },
    {
      path: 'old.txt',
      status: 'Deleted',
      additions: 0,
      deletions: 1,
      lines: [
        { kind: 'hunk', text: '@@ -1 +0,0 @@', oldNumber: null, newNumber: null },
        { kind: 'removed', text: 'gone', oldNumber: 1, newNumber: null },
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

const hunkPatch = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ export const app
 const first = 1
-const second = 2
-const third = 3
+const second = 20
+const added = 21
+const third = 30
 const last = 4
`

test('hunk headers start the numbering, and the split layout pairs removed lines with added ones beside the shared context', () => {
  const [change] = fileChangesOf(hunkPatch)
  const lines = change?.lines ?? []
  expect(lines.map(({ oldNumber, newNumber }) => [oldNumber, newNumber])).toEqual([
    [null, null],
    [10, 10],
    [11, null],
    [12, null],
    [null, 11],
    [null, 12],
    [null, 13],
    [13, 14],
  ])
  expect(splitRowsOf(lines).map(({ left, right }) => [left?.text ?? null, right?.text ?? null])).toEqual([
    ['@@ -10,4 +10,5 @@ export const app', '@@ -10,4 +10,5 @@ export const app'],
    ['const first = 1', 'const first = 1'],
    ['const second = 2', 'const second = 20'],
    ['const third = 3', 'const added = 21'],
    [null, 'const third = 30'],
    ['const last = 4', 'const last = 4'],
  ])
})

test('files start collapsed only when the whole diff is long', () => {
  const changeOf = (lineCount: number): FileChange => ({
    path: 'a.ts',
    status: 'Modified',
    additions: lineCount,
    deletions: 0,
    lines: Array.from({ length: lineCount }, () => ({ kind: 'added', text: '', oldNumber: null, newNumber: 1 })),
  })
  expect(isCollapsedByDefault([changeOf(200), changeOf(200)])).toBe(false)
  expect(isCollapsedByDefault([changeOf(200), changeOf(201)])).toBe(true)
})

test('the branch status reads ahead and behind counts, uncommitted files and leaves unknown values out', () => {
  expect(
    branchStatusPartsOf(
      branchStatusOf({ isLive: true, aheadOfBase: 1, behindBase: 0, uncommitted: 2, pushedAt: 'x' }),
      'main',
    ),
  ).toEqual(['1 ahead of main', '2 files uncommitted'])
  expect(
    branchStatusPartsOf(
      branchStatusOf({
        isLive: true,
        aheadOfBase: 2,
        behindBase: 3,
        aheadOfPushed: 1,
        behindPushed: 0,
        uncommitted: 0,
      }),
      'main',
    ),
  ).toEqual(['2 ahead of main', '3 behind main', '1 ahead of the pushed branch', 'No uncommitted files'])
  expect(
    branchStatusPartsOf(
      branchStatusOf({
        isLive: true,
        aheadOfBase: 0,
        behindBase: 0,
        aheadOfPushed: 0,
        behindPushed: 0,
        uncommitted: 1,
      }),
      'main',
    ),
  ).toEqual(['Up to date with main', 'Pushed branch up to date', '1 file uncommitted'])
  expect(branchStatusPartsOf(branchStatusOf({ isLive: false }), 'main')).toEqual([])
  expect(branchStatusOf({ isLive: true, pushedAt: '2026-10-18T10:00:00.000Z' }).pushedAt).toBe(
    '2026-10-18T10:00:00.000Z',
  )
})

test('the conflict prompt names the base and every conflicting file', () => {
  expect(conflictPromptOf('main', ['src/app.ts', 'README.md'])).toBe(
    'Merge the latest main (fetched as refs/hq/base) into the working branch, resolve the conflicts in these files, then commit:\n- src/app.ts\n- README.md',
  )
})
