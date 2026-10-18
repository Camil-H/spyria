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
export type PublishAction = 'push' | 'pull_request'

export const githubToolsPath = '/mcp/github'
export const noGitHubConnection = 'Connect your GitHub account in your profile to push'
export const publishingRefusalOf = (ownerName: string) =>
  `Only ${ownerName} can push or open pull requests in this chat`

export const githubTools = [
  {
    name: 'push_branch',
    description: "Push the chat's working branch to GitHub as the chat owner. Commit your changes first.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'open_pull_request',
    description:
      "Push the working branch and open a pull request against the chat's base branch as the chat owner. Commit your changes first.",
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
  },
]
export const publishActionOf = (toolName: unknown): PublishAction | undefined =>
  toolName === 'push_branch' ? 'push' : toolName === 'open_pull_request' ? 'pull_request' : undefined

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
