import type { PublishAction, PullRequestDraft } from './pull-requests.ts'

export type ThreadComment = { author: string; body: string }
export type ReviewThread = {
  path: string
  line: number | null
  isResolved: boolean
  isOutdated: boolean
  comments: ThreadComment[]
}
export type IssueState = 'open' | 'closed' | 'all'
export type IssueFilter = { state: IssueState; labels: string[]; search: string }
export type IssueSummary = {
  number: number
  title: string
  state: string
  author: string
  labels: string[]
  comments: number
  updatedAt: string
}
export type Issue = IssueSummary & { url: string; body: string; thread: ThreadComment[] }
export type PullRequestChange = { title?: string; body?: string }
export type GitHubToolCall =
  | { tool: 'publish'; action: PublishAction; draft: PullRequestDraft }
  | { tool: 'update_pull_request'; change: PullRequestChange }
  | { tool: 'fetch_branch'; branch: string }
  | { tool: 'read_review_threads'; number: number | null }
  | { tool: 'list_issues'; filter: IssueFilter }
  | { tool: 'read_issue'; number: number }

export const githubToolsPath = '/mcp/github'
export const githubToolsInstructions =
  "This runtime has no GitHub credentials, by design: git fetch, git pull, git push, gh and GitHub's API cannot reach this chat's repository from here. Use these tools instead. fetch_branch brings a branch into origin/<branch>; merge it rather than rebasing, since push_branch only fast-forwards the working branch. push_branch, open_pull_request and update_pull_request act as the chat owner, on the owner's prompts only. read_review_threads, list_issues and read_issue read the repository's pull request reviews and issues."

const branchNamePattern = /^\w[\w./-]*$/
const maximumBranchNameLength = 255
const maximumLabels = 10
const maximumSearchLength = 256
const maximumBodyCharacters = 4_000
const maximumReplyCharacters = 60_000
const issueStates: IssueState[] = ['open', 'closed', 'all']
const readOnlyTools = ['read_review_threads', 'list_issues', 'read_issue']

const readOnly = { annotations: { readOnlyHint: true } }
const numberProperty = { type: 'integer', minimum: 1 }

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
  {
    name: 'update_pull_request',
    description: "Change the title or the description of this chat's open pull request as the chat owner.",
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' } } },
  },
  {
    name: 'fetch_branch',
    description:
      "Fetch a branch of this chat's repository from GitHub into origin/<branch> in the runtime, leaving the working branch as it is. Then merge it, compare with it or check it out.",
    inputSchema: { type: 'object', properties: { branch: { type: 'string' } }, required: ['branch'] },
  },
  {
    name: 'read_review_threads',
    description:
      "Read the review threads of a pull request of this chat's repository: file, line, whether each is resolved or outdated, and its comments. Without a number, reads this chat's pull request.",
    inputSchema: { type: 'object', properties: { number: numberProperty } },
    ...readOnly,
  },
  {
    name: 'list_issues',
    description: "List up to 30 issues of this chat's repository, most recently updated first.",
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: issueStates, default: 'open' },
        labels: { type: 'array', items: { type: 'string' }, maxItems: maximumLabels },
        search: { type: 'string', description: 'Words to find in the title or the description' },
      },
    },
    ...readOnly,
  },
  {
    name: 'read_issue',
    description: "Read an issue of this chat's repository with its comments.",
    inputSchema: { type: 'object', properties: { number: numberProperty }, required: ['number'] },
    ...readOnly,
  },
]

export const isReadOnlyGitHubTool = (name: string) => readOnlyTools.includes(name)

const textOf = (value: unknown) => (typeof value === 'string' ? value : undefined)
const numberOf = (value: unknown) => (Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined)

const issueFilterOf = ({ state = 'open', labels = [], search = '' }: Record<string, unknown>) => {
  const isLabelList =
    Array.isArray(labels) && labels.length <= maximumLabels && labels.every((label) => typeof label === 'string')
  if (!issueStates.includes(state as IssueState) || !isLabelList || typeof search !== 'string') return undefined
  if (search.length > maximumSearchLength) return undefined
  return { state: state as IssueState, labels: labels as string[], search: search.trim() }
}

const isBranchName = (branch: string) =>
  branch.length <= maximumBranchNameLength && branchNamePattern.test(branch) && !branch.includes('..')

export const githubToolCallOf = (name: string, input: unknown): GitHubToolCall | { refusal: string } => {
  const parameters = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const invalid = { refusal: `The arguments of ${name} are not valid` }
  if (name === 'push_branch' || name === 'open_pull_request')
    return {
      tool: 'publish',
      action: name === 'push_branch' ? 'push' : 'pull_request',
      draft: { title: textOf(parameters.title) ?? '', body: textOf(parameters.body) ?? '' },
    }
  if (name === 'update_pull_request') {
    const title = textOf(parameters.title)?.trim()
    const body = textOf(parameters.body)
    if (!title && body === undefined) return { refusal: 'Give a new title or a new description' }
    return { tool: name, change: { ...(title && { title }), ...(body !== undefined && { body }) } }
  }
  if (name === 'fetch_branch') {
    const branch =
      textOf(parameters.branch)
        ?.trim()
        .replace(/^(refs\/heads\/|origin\/)/, '') ?? ''
    return isBranchName(branch)
      ? { tool: name, branch }
      : { refusal: `${branch || 'An empty name'} is not a branch name` }
  }
  if (name === 'read_review_threads') {
    const number = parameters.number === undefined ? null : numberOf(parameters.number)
    return number === undefined ? invalid : { tool: name, number }
  }
  if (name === 'list_issues') {
    const filter = issueFilterOf(parameters)
    return filter ? { tool: name, filter } : invalid
  }
  if (name === 'read_issue') {
    const number = numberOf(parameters.number)
    return number ? { tool: name, number } : invalid
  }
  return { refusal: `Unknown tool ${name}` }
}

const shortened = (text: string, limit = maximumBodyCharacters) =>
  text.length > limit ? `${text.slice(0, limit)}\n[truncated]` : text

const indented = (text: string) => text.trim().replaceAll('\n', '\n    ')

const commentLinesOf = (comments: ThreadComment[]) =>
  comments.map(({ author, body }) => `  ${author}: ${indented(shortened(body))}`)

export const reviewThreadsTextOf = (number: number, threads: ReviewThread[]) => {
  const unresolved = threads.filter((thread) => !thread.isResolved).length
  return shortened(
    [
      `Pull request #${number}: ${threads.length} review threads, ${unresolved} unresolved`,
      ...threads.flatMap(({ path, line, isResolved, isOutdated, comments }) => [
        `- ${path}${line === null ? '' : `:${line}`} (${[isResolved ? 'resolved' : 'unresolved', ...(isOutdated ? ['outdated'] : [])].join(', ')})`,
        ...commentLinesOf(comments),
      ]),
    ].join('\n'),
    maximumReplyCharacters,
  )
}

const issueLineOf = ({ number, title, state, author, labels, comments, updatedAt }: IssueSummary) =>
  `#${number} [${state}] ${title} by ${author}${labels.length > 0 ? `, labels: ${labels.join(', ')}` : ''}, ${comments} comments, updated ${updatedAt.slice(0, 10)}`

export const issuesTextOf = (issues: IssueSummary[]) =>
  issues.length === 0 ? 'No issue matches' : shortened(issues.map(issueLineOf).join('\n'), maximumReplyCharacters)

export const issueTextOf = (issue: Issue) =>
  shortened(
    [
      issueLineOf(issue),
      issue.url,
      '',
      shortened(issue.body.trim() || '(no description)'),
      ...(issue.thread.length > 0 ? ['', 'Comments:', ...commentLinesOf(issue.thread)] : []),
    ].join('\n'),
    maximumReplyCharacters,
  )
