import { expect, test } from 'bun:test'
import {
  githubToolCallOf,
  githubTools,
  isReadOnlyGitHubTool,
  issuesTextOf,
  issueTextOf,
  reviewThreadsTextOf,
} from './github-tools.ts'

test('publishing tools map to publish actions with their draft', () => {
  expect(githubToolCallOf('push_branch', {})).toEqual({
    tool: 'publish',
    action: 'push',
    draft: { title: '', body: '' },
  })
  expect(githubToolCallOf('open_pull_request', { title: 'Fix', body: 'Why' })).toEqual({
    tool: 'publish',
    action: 'pull_request',
    draft: { title: 'Fix', body: 'Why' },
  })
  expect(githubToolCallOf('force_push', {})).toEqual({ refusal: 'Unknown tool force_push' })
})

test('a pull request update needs a title or a description and keeps an emptied description', () => {
  expect(githubToolCallOf('update_pull_request', { title: ' New title ' })).toEqual({
    tool: 'update_pull_request',
    change: { title: 'New title' },
  })
  expect(githubToolCallOf('update_pull_request', { body: '' })).toEqual({
    tool: 'update_pull_request',
    change: { body: '' },
  })
  for (const input of [{}, { title: '  ' }, { title: 3 }, null])
    expect(githubToolCallOf('update_pull_request', input)).toEqual({ refusal: 'Give a new title or a new description' })
})

test('a fetched branch name drops refs/heads/ or origin/ and refuses option-like or traversing names', () => {
  expect(githubToolCallOf('fetch_branch', { branch: 'feature/totals' })).toEqual({
    tool: 'fetch_branch',
    branch: 'feature/totals',
  })
  expect(githubToolCallOf('fetch_branch', { branch: 'origin/main' })).toEqual({ tool: 'fetch_branch', branch: 'main' })
  expect(githubToolCallOf('fetch_branch', { branch: 'refs/heads/main' })).toEqual({
    tool: 'fetch_branch',
    branch: 'main',
  })
  for (const branch of ['--upload-pack=touch', 'a..b', 'a b', 'x'.repeat(256)])
    expect(githubToolCallOf('fetch_branch', { branch })).toEqual({ refusal: `${branch} is not a branch name` })
  expect(githubToolCallOf('fetch_branch', {})).toEqual({ refusal: 'An empty name is not a branch name' })
})

test('read tools take a positive number, issue filters default to open and every argument is checked', () => {
  expect(githubToolCallOf('read_review_threads', {})).toEqual({ tool: 'read_review_threads', number: null })
  expect(githubToolCallOf('read_review_threads', { number: 4 })).toEqual({ tool: 'read_review_threads', number: 4 })
  expect(githubToolCallOf('read_issue', { number: 7 })).toEqual({ tool: 'read_issue', number: 7 })
  expect(githubToolCallOf('list_issues', {})).toEqual({
    tool: 'list_issues',
    filter: { state: 'open', labels: [], search: '' },
  })
  expect(githubToolCallOf('list_issues', { state: 'all', labels: ['bug'], search: ' totals ' })).toEqual({
    tool: 'list_issues',
    filter: { state: 'all', labels: ['bug'], search: 'totals' },
  })
  for (const [name, input] of [
    ['read_review_threads', { number: 0 }],
    ['read_issue', {}],
    ['read_issue', { number: '7' }],
    ['read_issue', { number: 1.5 }],
    ['list_issues', { state: 'merged' }],
    ['list_issues', { labels: 'bug' }],
    ['list_issues', { labels: Array.from({ length: 11 }, () => 'x') }],
    ['list_issues', { search: 'x'.repeat(257) }],
  ] as const)
    expect(githubToolCallOf(name, input)).toEqual({ refusal: `The arguments of ${name} are not valid` })
})

test('only the reading tools are read-only, and every tool is listed', () => {
  expect(githubTools.filter(({ name }) => isReadOnlyGitHubTool(name)).map(({ name }) => name)).toEqual([
    'read_review_threads',
    'list_issues',
    'read_issue',
  ])
  expect(githubTools.map(({ name }) => name)).toEqual([
    'push_branch',
    'open_pull_request',
    'update_pull_request',
    'fetch_branch',
    'read_review_threads',
    'list_issues',
    'read_issue',
  ])
})

test('review threads, issue lists and issues read as text, with long bodies truncated', () => {
  expect(
    reviewThreadsTextOf(3, [
      {
        path: 'src/app.ts',
        line: 4,
        isResolved: false,
        isOutdated: true,
        comments: [
          { author: 'rita', body: 'Use a constant.\nIt reads better.' },
          { author: 'alice-martin', body: 'Done.' },
        ],
      },
      { path: 'README.md', line: null, isResolved: true, isOutdated: false, comments: [] },
    ]),
  ).toBe(
    [
      'Pull request #3: 2 review threads, 1 unresolved',
      '- src/app.ts:4 (unresolved, outdated)',
      '  rita: Use a constant.',
      '    It reads better.',
      '  alice-martin: Done.',
      '- README.md (resolved)',
    ].join('\n'),
  )
  const issue = {
    number: 12,
    title: 'Totals are wrong',
    state: 'open',
    author: 'rita',
    labels: ['bug'],
    comments: 1,
    updatedAt: '2026-10-20T08:00:00Z',
  }
  expect(issuesTextOf([])).toBe('No issue matches')
  expect(issuesTextOf([issue, { ...issue, number: 13, labels: [] }])).toBe(
    '#12 [open] Totals are wrong by rita, labels: bug, 1 comments, updated 2026-10-20\n#13 [open] Totals are wrong by rita, 1 comments, updated 2026-10-20',
  )
  const text = issueTextOf({
    ...issue,
    url: 'https://github.com/acme/app/issues/12',
    body: 'x'.repeat(4_001),
    thread: [{ author: 'lee', body: 'Seen it too' }],
  })
  expect(text).toStartWith(
    '#12 [open] Totals are wrong by rita, labels: bug, 1 comments, updated 2026-10-20\nhttps://github.com/acme/app/issues/12\n\n',
  )
  expect(text).toContain(`${'x'.repeat(4_000)}\n[truncated]`)
  expect(text).toEndWith('\n\nComments:\n  lee: Seen it too')
  expect(issueTextOf({ ...issue, url: 'u', body: ' ', thread: [] })).toEndWith('\n(no description)')
})
