import { expect, test } from 'bun:test'
import { checkStateOf, checksOf, githubAccessRefusalOf, publishToolOf, reviewPromptOf } from './pull-requests.ts'

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
  expect(publishToolOf('push')).toBe('push_branch')
  expect(publishToolOf('pull_request')).toBe('open_pull_request')
})
