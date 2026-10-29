import { expect, test } from 'bun:test'
import {
  branchStatusOf,
  branchStatusPartsOf,
  changeGroupsOf,
  changeMarkOf,
  codeFenceOf,
  commitsOf,
  conflictPromptOf,
  type DiffLine,
  diffLayoutFor,
  type FileChange,
  fileChangesOf,
  hasNothingToCommit,
  hasNothingToPush,
  isCollapsedByDefault,
  lineNumberDigitsOf,
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

const shaOf = (digit: string) => digit.repeat(40)

test('a NUL-separated git log becomes commits with a short sha and their body, whatever other control characters their messages hold', () => {
  const log = [
    shaOf('a'),
    'Fix \x1f the totals',
    'Pi Agent',
    '2026-10-18T13:20:00+02:00',
    'The total was off.\n\nSee \x1e #12.\n',
    shaOf('b'),
    'Add tax',
    'Alice',
    '2026-10-18T10:00:00+00:00',
    '',
    '',
  ].join('\0')
  expect(commitsOf(log)).toEqual([
    {
      sha: 'aaaaaaa',
      subject: 'Fix \x1f the totals',
      author: 'Pi Agent',
      committedAt: '2026-10-18T11:20:00.000Z',
      body: 'The total was off.\n\nSee \x1e #12.',
    },
    { sha: 'bbbbbbb', subject: 'Add tax', author: 'Alice', committedAt: '2026-10-18T10:00:00.000Z', body: '' },
  ])
  expect(commitsOf(log.slice(0, log.indexOf('Add tax')))).toHaveLength(1)
  expect(commitsOf('')).toEqual([])
})

test('a log from before the NUL separators still reads, one commit per line', () => {
  expect(commitsOf(`${shaOf('c')}\x1fNo date\n${shaOf('d')}\x1fFix\x1fAlice\x1f2026-10-18T10:00:00+00:00\n`)).toEqual([
    { sha: 'ccccccc', subject: 'No date', author: '', committedAt: '', body: '' },
    { sha: 'ddddddd', subject: 'Fix', author: 'Alice', committedAt: '2026-10-18T10:00:00.000Z', body: '' },
  ])
})

test('changes split into the files not staged, the files staged but not committed, then each commit with a change, the oldest marked when cut', () => {
  const [readme = '', added = ''] = patch.split(/(?=^diff --git a\/src)/m)
  const changes = { isLive: true, unstaged: added, staged: readme, cut: ['staged'] }
  const commits = {
    isLive: true,
    commitPatches: `\0${shaOf('a')}\n\n${readme}\0${shaOf('b')}\n\0${shaOf('c')}\n\n${readme}\0${shaOf('d').slice(0, 9)}`,
    log: [shaOf('a'), 'Fix the readme', 'Alice', '', '', shaOf('b'), 'Merge main', 'Alice', '', '', ''].join('\0'),
    cut: ['commitPatches'],
  }
  expect(
    changeGroupsOf(changes, commits).map(({ sha, title, commit, changes, isCut }) => [
      sha,
      title,
      commit?.author,
      changes.map(({ path }) => path),
      isCut,
    ]),
  ).toEqual([
    [undefined, 'Not staged', undefined, ['src/new.ts', 'old.txt', 'logo.png'], false],
    [undefined, 'Staged, not committed', undefined, ['README.md'], true],
    ['aaaaaaa', 'Fix the readme', 'Alice', ['README.md'], false],
    ['ccccccc', '', undefined, ['README.md'], true],
  ])
  expect(changeGroupsOf({ ...changes, cut: [] }, { ...commits, cut: [] }).map(({ isCut }) => isCut)).toEqual([
    false,
    false,
    false,
    false,
  ])
})

test('changes from a snapshot taken before the split read as one untitled group, cut when the snapshot was', () => {
  const older = { isLive: false, patch, log: '', truncated: true }
  expect(changeGroupsOf(older, older)).toEqual([{ title: '', changes: fileChangesOf(patch), isCut: true }])
  expect(changeGroupsOf({ isLive: true, unstaged: '', staged: '', patch: '' }, undefined)).toEqual([])
  expect(changeGroupsOf(undefined, undefined)).toEqual([])
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
    'Merge the latest main (fetched as refs/spyria/base) into the working branch, resolve the conflicts in these files, then commit:\n- src/app.ts\n- README.md',
  )
})

test('the diff shows side by side from a 560px panel and unified below, where side-by-side lines would wrap mid-word', () => {
  expect(diffLayoutFor(280)).toBe('unified')
  expect(diffLayoutFor(559)).toBe('unified')
  expect(diffLayoutFor(560)).toBe('split')
  expect(diffLayoutFor(900)).toBe('split')
})

test('the side-by-side line number columns fit the widest line number, at least four digits', () => {
  const lineOf = (kind: DiffLine['kind'], text: string, oldNumber: number | null, newNumber: number | null) => ({
    kind,
    text,
    oldNumber,
    newNumber,
  })
  expect(lineNumberDigitsOf([])).toBe(4)
  expect(
    lineNumberDigitsOf([
      lineOf('hunk', '@@ -99998,3 +99998,4 @@', null, null),
      lineOf('context', 'short', 99998, 99998),
      lineOf('added', 'added', null, 100001),
    ]),
  ).toBe(6)
})

test('there is nothing to commit with no uncommitted file, and nothing to push with no commit ahead of the pushed branch, or of the base before a first push; an unknown status allows both', () => {
  const statusOf = (reading: object) => branchStatusOf({ isLive: true, ...reading })
  expect(hasNothingToCommit(statusOf({ uncommitted: 0 }))).toBe(true)
  expect(hasNothingToCommit(statusOf({ uncommitted: 2 }))).toBe(false)
  expect(hasNothingToPush(statusOf({ aheadOfBase: 2, aheadOfPushed: 0, behindPushed: 0 }))).toBe(true)
  expect(hasNothingToPush(statusOf({ aheadOfBase: 2, aheadOfPushed: 1, behindPushed: 0 }))).toBe(false)
  expect(hasNothingToPush(statusOf({ aheadOfBase: 0, uncommitted: 3 }))).toBe(true)
  expect(hasNothingToPush(statusOf({ aheadOfBase: 1 }))).toBe(false)
  for (const unknown of [branchStatusOf(undefined), branchStatusOf({ isLive: false })]) {
    expect(hasNothingToCommit(unknown)).toBe(false)
    expect(hasNothingToPush(unknown)).toBe(false)
  }
})
