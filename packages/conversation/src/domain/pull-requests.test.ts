import { expect, test } from 'bun:test'
import {
  cannotPostRefusalOf,
  checkStateOf,
  checksOf,
  githubAccessRefusalOf,
  publishToolOf,
  reviewPromptOf,
  withRecordedReviews,
} from './pull-requests.ts'

test('the checks summary is failing if any check fails, pending while any is pending or none ran, else passing', () => {
  expect(checksOf({ checks: {} })).toBe('pending')
  expect(checksOf({ checks: { a: 'passing', b: 'pending' } })).toBe('pending')
  expect(checksOf({ checks: { a: 'passing', b: 'failing' } })).toBe('failing')
  expect(checksOf({ checks: { a: 'passing' } })).toBe('passing')
})

test('a check is pending until it completes, then passes on success, neutral or skipped and fails otherwise', () => {
  expect(checkStateOf(false, null)).toBe('pending')
  for (const conclusion of ['success', 'neutral', 'skipped']) expect(checkStateOf(true, conclusion)).toBe('passing')
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', null])
    expect(checkStateOf(true, conclusion)).toBe('failing')
})

test('the review prompt lists every unresolved comment with file, line, author and body', () => {
  const comment = { path: 'src/app.ts', author: 'rita', isResolved: false }
  expect(
    reviewPromptOf({
      number: 1,
      comments: [
        { ...comment, id: 1, line: 1, body: 'Use a constant' },
        { ...comment, id: 2, line: null, body: 'Add a test' },
        { ...comment, id: 3, line: 3, body: 'Done already', isResolved: true },
      ],
    }),
  ).toBe(
    'Address the review comments on pull request #1, then commit:\n- src/app.ts:1 (rita): Use a constant\n- src/app.ts (rita): Add a test',
  )
})

test('publishing names the member whose access to GitHub refuses the tool, and the tool each action needs', () => {
  expect(githubAccessRefusalOf('Bob', 'push_branch')).toBe(
    "Bob's access to GitHub does not include push_branch in this chat",
  )
  expect(cannotPostRefusalOf('Lee')).toBe('Lee cannot post in this chat')
  expect(publishToolOf('push')).toBe('push_branch')
  expect(publishToolOf('pull_request')).toBe('open_pull_request')
})

test('a pull request read back after a push keeps the reviews, comments and checks recorded while it was pushed', () => {
  const read = {
    type: 'pull_request' as const,
    repository: 'acme/app',
    number: 7,
    url: 'https://github.com/acme/app/pull/7',
    title: 'Fix the totals',
    state: 'open' as const,
    headSha: 'second',
    commits: 2,
    checks: { 'check_run:1': 'pending' as const },
    review: null,
    comments: [],
  }
  const comment = { id: 3, path: 'src/app.ts', line: 1, author: 'rita', body: 'Rename it', isResolved: false }
  const recorded = {
    ...read,
    headSha: 'first',
    commits: 1,
    checks: { 'check_run:0': 'failing' as const },
    review: 'changes_requested' as const,
    comments: [comment],
  }
  expect(withRecordedReviews(read, recorded)).toEqual({
    ...read,
    review: 'changes_requested',
    comments: [comment],
  })
  const checkedMeanwhile = { ...recorded, headSha: 'second', checks: { 'check_run:2': 'passing' as const } }
  expect(withRecordedReviews(read, checkedMeanwhile).checks).toEqual({
    'check_run:1': 'pending',
    'check_run:2': 'passing',
  })
  const readBeforeGitHubCaughtUp = { ...read, headSha: 'first', checks: { 'check_run:0': 'failing' as const } }
  const caughtUp = withRecordedReviews(readBeforeGitHubCaughtUp, checkedMeanwhile, 'second')
  expect({ headSha: caughtUp.headSha, checks: caughtUp.checks }).toEqual({
    headSha: 'second',
    checks: { 'check_run:2': 'passing' },
  })
})
