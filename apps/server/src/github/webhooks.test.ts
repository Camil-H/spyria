import { expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { isSignedBy, pullRequestNumbersOf, pullRequestStepOf, updatedPullRequest } from './webhooks.ts'

const apiPullRequest = {
  number: 1,
  html_url: 'https://github.com/acme/app/pull/1',
  title: 'Fix the totals',
  state: 'open',
  draft: false,
  merged: false,
  head: { sha: 'aaa' },
  commits: 1,
}
const opened = pullRequestStepOf('acme/app', apiPullRequest)
const comment = (id: number, line: number) => ({
  id,
  path: 'src/app.ts',
  line,
  user: { login: 'rita' },
  body: `Comment ${id}`,
})

test('a signature is the sha256 HMAC of the raw body with the webhook secret; anything else is refused', () => {
  const body = '{"action":"completed"}'
  const signature = `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`
  expect(isSignedBy('secret', body, signature)).toBe(true)
  expect(isSignedBy('other', body, signature)).toBe(false)
  expect(isSignedBy('secret', `${body} `, signature)).toBe(false)
  expect(isSignedBy('secret', body, undefined)).toBe(false)
  expect(isSignedBy('secret', body, signature.slice(0, -1))).toBe(false)
})

test('a pull request from the API or a pull_request webhook sets the state, keeping checks only for the same head', () => {
  expect(opened).toEqual({
    type: 'pull_request',
    repository: 'acme/app',
    number: 1,
    url: 'https://github.com/acme/app/pull/1',
    title: 'Fix the totals',
    state: 'open',
    headSha: 'aaa',
    commits: 1,
    checks: {},
    review: null,
    comments: [],
  })
  const checked = { ...opened, checks: { 'check_suite:1': 'passing' as const } }
  expect(pullRequestStepOf('acme/app', { ...apiPullRequest, draft: true }, checked)).toMatchObject({
    state: 'draft',
    checks: { 'check_suite:1': 'passing' },
  })
  expect(
    updatedPullRequest(checked, 'pull_request', {
      action: 'synchronize',
      pull_request: { ...apiPullRequest, head: { sha: 'bbb' }, commits: 2 },
    }),
  ).toMatchObject({ headSha: 'bbb', commits: 2, checks: {} })
  const closed = { ...apiPullRequest, state: 'closed' }
  expect(updatedPullRequest(opened, 'pull_request', { action: 'closed', pull_request: closed }).state).toBe('closed')
  expect(
    updatedPullRequest(opened, 'pull_request', { action: 'closed', pull_request: { ...closed, merged: true } }).state,
  ).toBe('merged')
})

test('check suites and runs of the current head make the checks pending, passing or failing; other heads are ignored', () => {
  const suite = (action: string, conclusion: string | null, headSha = 'aaa', id = 1) => ({
    action,
    check_suite: { id, head_sha: headSha, conclusion, pull_requests: [{ number: 1 }] },
  })
  const pending = updatedPullRequest(opened, 'check_suite', suite('requested', null))
  expect(pending.checks).toEqual({ 'check_suite:1': 'pending' })
  const passing = updatedPullRequest(pending, 'check_suite', suite('completed', 'success'))
  expect(passing.checks).toEqual({ 'check_suite:1': 'passing' })
  const failing = updatedPullRequest(passing, 'check_run', {
    action: 'completed',
    check_run: { id: 9, head_sha: 'aaa', conclusion: 'failure', pull_requests: [{ number: 1 }] },
  })
  expect(failing.checks).toEqual({ 'check_suite:1': 'passing', 'check_run:9': 'failing' })
  expect(updatedPullRequest(opened, 'check_suite', suite('completed', 'success', 'old'))).toBe(opened)
  expect(pullRequestNumbersOf('check_suite', suite('completed', 'success'))).toEqual([1])
  expect(pullRequestNumbersOf('push', {})).toEqual([])
})

test('reviews set the review state, review comments are added, edited, deleted and resolved by thread', () => {
  const requested = updatedPullRequest(opened, 'pull_request_review', {
    action: 'submitted',
    review: { state: 'CHANGES_REQUESTED' },
  })
  expect(requested.review).toBe('changes_requested')
  expect(
    updatedPullRequest(requested, 'pull_request_review', { action: 'dismissed', review: { state: 'x' } }).review,
  ).toBe(null)
  const commented = [comment(11, 1), comment(12, 2)].reduce(
    (step, added) => updatedPullRequest(step, 'pull_request_review_comment', { action: 'created', comment: added }),
    requested,
  )
  expect(commented.comments).toEqual([
    { id: 11, path: 'src/app.ts', line: 1, author: 'rita', body: 'Comment 11', isResolved: false },
    { id: 12, path: 'src/app.ts', line: 2, author: 'rita', body: 'Comment 12', isResolved: false },
  ])
  const resolved = updatedPullRequest(commented, 'pull_request_review_thread', {
    action: 'resolved',
    thread: { comments: [{ id: 11 }] },
  })
  expect(resolved.comments.map(({ isResolved }) => isResolved)).toEqual([true, false])
  const edited = updatedPullRequest(resolved, 'pull_request_review_comment', {
    action: 'edited',
    comment: { ...comment(11, 1), body: 'Edited' },
  })
  expect(edited.comments[0]).toMatchObject({ body: 'Edited', isResolved: true })
  const deleted = updatedPullRequest(edited, 'pull_request_review_comment', {
    action: 'deleted',
    comment: comment(12, 2),
  })
  expect(deleted.comments.map(({ id }) => id)).toEqual([11])
})
