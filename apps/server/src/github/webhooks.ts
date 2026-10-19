import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PullRequestStep, ReviewComment } from '@spyria/conversation/server'

export type GitHubPullRequest = {
  number: number
  html_url: string
  title: string
  state: string
  draft?: boolean
  merged?: boolean
  merged_at?: string | null
  head: { sha: string }
  commits?: number
}
type Check = { id: number; head_sha: string; conclusion: string | null; pull_requests?: { number: number }[] }
type WebhookComment = {
  id: number
  path: string
  line?: number | null
  original_line?: number | null
  user: { login: string }
  body: string
}
export type WebhookPayload = {
  action?: string
  repository?: { full_name: string }
  pull_request?: GitHubPullRequest
  review?: { state: string }
  comment?: WebhookComment
  thread?: { comments: { id: number }[] }
  check_suite?: Check
  check_run?: Check
}

const passingConclusions = ['success', 'neutral', 'skipped']
const reviewStates = ['approved', 'changes_requested', 'commented'] as const

export const isSignedBy = (secret: string, body: string, signature: string | undefined) => {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`)
  const given = Buffer.from(signature ?? '')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export const pullRequestStepOf = (
  repository: string,
  pullRequest: GitHubPullRequest,
  previous?: PullRequestStep,
): PullRequestStep => ({
  type: 'pull_request',
  repository,
  number: pullRequest.number,
  url: pullRequest.html_url,
  title: pullRequest.title,
  state:
    pullRequest.merged || pullRequest.merged_at
      ? 'merged'
      : pullRequest.state === 'closed'
        ? 'closed'
        : pullRequest.draft
          ? 'draft'
          : 'open',
  headSha: pullRequest.head.sha,
  commits: pullRequest.commits ?? previous?.commits ?? 0,
  checks: previous?.headSha === pullRequest.head.sha ? previous.checks : {},
  review: previous?.review ?? null,
  comments: previous?.comments ?? [],
})

const checkOf = (event: string, payload: WebhookPayload) =>
  event === 'check_suite' ? payload.check_suite : event === 'check_run' ? payload.check_run : undefined

export const pullRequestNumbersOf = (event: string, payload: WebhookPayload) =>
  payload.pull_request
    ? [payload.pull_request.number]
    : (checkOf(event, payload)?.pull_requests ?? []).map(({ number }) => number)

const commentOf = (comment: WebhookComment): ReviewComment => ({
  id: comment.id,
  path: comment.path,
  line: comment.line ?? comment.original_line ?? null,
  author: comment.user.login,
  body: comment.body,
  isResolved: false,
})

export const updatedPullRequest = (step: PullRequestStep, event: string, payload: WebhookPayload): PullRequestStep => {
  const { action, comment, review, thread } = payload
  const check = checkOf(event, payload)
  if (event === 'pull_request' && payload.pull_request)
    return pullRequestStepOf(step.repository, payload.pull_request, step)
  if (event === 'pull_request_review' && review) {
    const state = review.state.toLowerCase()
    const reviewState = reviewStates.find((known) => known === state) ?? null
    if (action === 'submitted' && reviewState) return { ...step, review: reviewState }
    return action === 'dismissed' ? { ...step, review: null } : step
  }
  if (event === 'pull_request_review_comment' && comment) {
    const others = step.comments.filter(({ id }) => id !== comment.id)
    if (action === 'deleted') return { ...step, comments: others }
    const kept = step.comments.find(({ id }) => id === comment.id)
    const updated = { ...commentOf(comment), isResolved: kept?.isResolved ?? false }
    return {
      ...step,
      comments: kept ? step.comments.map((known) => (known === kept ? updated : known)) : [...others, updated],
    }
  }
  if (event === 'pull_request_review_thread' && thread) {
    const ids = new Set(thread.comments.map(({ id }) => id))
    const isResolved = action === 'resolved'
    return { ...step, comments: step.comments.map((known) => (ids.has(known.id) ? { ...known, isResolved } : known)) }
  }
  if (!check || check.head_sha !== step.headSha) return step
  const state =
    action !== 'completed' ? 'pending' : passingConclusions.includes(check.conclusion ?? '') ? 'passing' : 'failing'
  return { ...step, checks: { ...step.checks, [`${event}:${check.id}`]: state } }
}
