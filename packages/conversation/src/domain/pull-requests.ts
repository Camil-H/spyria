import type { MemberId } from '@spyria/kernel'

export type CheckState = 'pending' | 'passing' | 'failing'
export type ReviewComment = {
  id: number
  path: string
  line: number | null
  author: string
  body: string
  isResolved: boolean
}
export type PullRequestStep = {
  type: 'pull_request'
  repository: string
  number: number
  url: string
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  headSha: string
  commits: number
  checks: Record<string, CheckState>
  review: 'approved' | 'changes_requested' | 'commented' | null
  comments: ReviewComment[]
}
export type PullRequestDraft = { title: string; body: string }

const closedStates: PullRequestStep['state'][] = ['merged', 'closed']
export const isOpenPullRequest = (step: PullRequestStep) => !closedStates.includes(step.state)
export const keepsSourceBranch = (
  source: { baseBranch: string | null; ownerId: MemberId | null },
  memberId: MemberId,
) => source.baseBranch !== null && source.ownerId === memberId
export type PublishAction = 'push' | 'pull_request'

export const noGitHubConnection = 'Connect your GitHub account in your profile to push'
export const publishingRefusalOf = (ownerName: string) =>
  `Only ${ownerName} can push or open pull requests in this chat`

export const checksOf = ({ checks }: Pick<PullRequestStep, 'checks'>): CheckState => {
  const states = Object.values(checks)
  return states.includes('failing')
    ? 'failing'
    : states.length === 0 || states.includes('pending')
      ? 'pending'
      : 'passing'
}

export const unresolvedCommentsOf = ({ comments }: Pick<PullRequestStep, 'comments'>) =>
  comments.filter((comment) => !comment.isResolved)

export const reviewPromptOf = (pullRequest: Pick<PullRequestStep, 'number' | 'comments'>) =>
  [
    `Address the review comments on pull request #${pullRequest.number}, then commit:`,
    ...unresolvedCommentsOf(pullRequest).map(
      ({ path, line, author, body }) => `- ${path}${line === null ? '' : `:${line}`} (${author}): ${body}`,
    ),
  ].join('\n')
