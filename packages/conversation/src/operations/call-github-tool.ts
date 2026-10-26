import { DomainError, type MemberId, requireChatPermission } from '@spyria/kernel'
import type { AgentChat, RepositoryCheckouts } from '../contracts/agent.ts'
import { asleepRefusal } from '../domain/git-actions.ts'
import {
  type GitHubToolCall,
  githubToolCallOf,
  issuesTextOf,
  issueTextOf,
  reviewThreadsTextOf,
} from '../domain/github-tools.ts'
import { agentWorkspacePathOf, runtimeHeadsOf } from '../domain/workspace-reads.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { type Publication, publishBranch, updatePullRequest } from './publish-branch.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient' | 'checkouts'>
type RepositoryDependencies = Omit<Dependencies, 'checkouts'> & { checkouts: RepositoryCheckouts }
type RepositoryChat = { chat: AgentChat; baseBranch: string; pullRequestNumber: number | null }
type Input = { chat: AgentChat; memberId: MemberId; name: string; input: unknown }

const refused = (text: string): Publication => ({ isRefused: true, text })
const answered = (text: string): Publication => ({ isRefused: false, text })

const fetchBranch = async (
  { runtimes, agentClient, checkouts }: RepositoryDependencies,
  { chat, baseBranch }: RepositoryChat,
  branch: string,
) => {
  const endpoint = await runtimes.endpointOf(chat)
  if (!endpoint) return refused(asleepRefusal)
  const status = await agentClient.readWorkspace(endpoint, agentWorkspacePathOf('status', '', baseBranch))
  const bundled = await checkouts.fetchBundle(chat, branch, runtimeHeadsOf(status))
  if ('failure' in bundled) return refused(bundled.failure)
  const fetched = await agentClient.actOnWorkspace(endpoint, 'fetch', { branch, ...bundled })
  if ('failure' in fetched) return refused(String(fetched.failure))
  return answered(`Fetched ${branch} at ${bundled.head.slice(0, 7)} into origin/${branch}`)
}

const readReviewThreads = async (
  { checkouts }: RepositoryDependencies,
  { chat, pullRequestNumber }: RepositoryChat,
  number: number | null,
) => {
  const read = number ?? pullRequestNumber
  if (read === null) return refused('This chat has no pull request: give the number of the one to read')
  return answered(reviewThreadsTextOf(read, await checkouts.reviewThreadsOf(chat, read)))
}

const repositoryTool = (
  dependencies: RepositoryDependencies,
  repositoryChat: RepositoryChat,
  call: Exclude<GitHubToolCall, { tool: 'publish' | 'update_pull_request' }>,
) => {
  const { checkouts } = dependencies
  const { chat } = repositoryChat
  if (call.tool === 'fetch_branch') return fetchBranch(dependencies, repositoryChat, call.branch)
  if (call.tool === 'read_review_threads') return readReviewThreads(dependencies, repositoryChat, call.number)
  if (call.tool === 'list_issues') return checkouts.issuesOf(chat, call.filter).then(issuesTextOf).then(answered)
  return checkouts.issueOf(chat, call.number).then(issueTextOf).then(answered)
}

export const callGitHubTool = async (dependencies: Dependencies, { chat, memberId, name, input }: Input) => {
  const call = githubToolCallOf(name, input)
  if ('refusal' in call) return refused(call.refusal)
  if (call.tool === 'publish')
    return publishBranch(dependencies, { chat, memberId, action: call.action, draft: call.draft })
  if (call.tool === 'update_pull_request')
    return updatePullRequest(dependencies, { chat, memberId, change: call.change })
  const { transactor, checkouts } = dependencies
  const { baseBranch, pullRequestNumber } = await transactor.run(async ({ chats, messages }) => {
    await requireChatPermission(chats, chat.chatId, memberId, 'chat.read')
    const card = await messages.pullRequestCard(chat.chatId)
    return {
      baseBranch: (await chats.get(chat.chatId)).baseBranch,
      pullRequestNumber: card?.step?.type === 'pull_request' ? card.step.number : null,
    }
  })
  if (!baseBranch || !checkouts) return refused('This chat has no repository')
  return repositoryTool({ ...dependencies, checkouts }, { chat, baseBranch, pullRequestNumber }, call).catch(
    (error: unknown) => {
      if (error instanceof DomainError) return refused(error.message)
      throw error
    },
  )
}
