import { DomainError, type MemberId, requireChatPermission } from '@hq/kernel'
import type { AgentChat, AgentEndpoint, GitAuthor } from '../contracts/agent.ts'
import {
  asleepRefusal,
  conflictTextOf,
  type GitAction,
  type GitActionOutcome,
  gitActionRefusalOf,
  noReplyAuthorOf,
  turnRunningRefusal,
} from '../domain/git-actions.ts'
import { agentWorkspacePathOf } from '../domain/workspace-reads.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Required<Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient' | 'checkouts'>>
type Input = { chat: AgentChat; memberId: MemberId; action: GitAction; message: string }
type Acting = { chat: AgentChat; endpoint: AgentEndpoint; author: GitAuthor; baseBranch: string; message: string }

const refused = (text: string): GitActionOutcome => ({ isRefused: true, text })

const commit = async ({ agentClient }: Dependencies, { endpoint, author, message }: Acting) => {
  const committed = await agentClient.actOnWorkspace(endpoint, 'commit', { message, author })
  if ('failure' in committed) return refused(String(committed.failure))
  return { isRefused: false, text: `Committed ${String(committed.sha).slice(0, 7)}` }
}

const update = async ({ agentClient, checkouts }: Dependencies, { chat, endpoint, author, baseBranch }: Acting) => {
  const status = (await agentClient.readWorkspace(endpoint, agentWorkspacePathOf('status', '', baseBranch))) as
    | { baseHead?: unknown }
    | undefined
  const bundled = await checkouts.bundleBase(chat, typeof status?.baseHead === 'string' ? status.baseHead : null)
  if ('failure' in bundled) return refused(bundled.failure)
  const merged = await agentClient.actOnWorkspace(endpoint, 'merge', { base: baseBranch, ...bundled, author })
  if ('failure' in merged) return refused(String(merged.failure))
  if (Array.isArray(merged.conflicts))
    return { ...refused(conflictTextOf(baseBranch, merged.conflicts)), conflicts: merged.conflicts.map(String) }
  return {
    isRefused: false,
    text: merged.isUpToDate ? `Already up to date with ${baseBranch}` : `Merged ${baseBranch}`,
  }
}

const acts = { commit, update }

export const runGitAction = async (
  dependencies: Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient' | 'checkouts'>,
  { chat, memberId, action, message }: Input,
): Promise<GitActionOutcome> => {
  const { transactor, runtimes, checkouts } = dependencies
  const { ownerId, ownerName, isOwnerRemoved, baseBranch, isTurnRunning } = await transactor.run(
    async ({ chats, members, agentTurns }) => {
      await requireChatPermission(chats, chat.chatId, memberId, 'chat.read')
      const stored = await chats.get(chat.chatId)
      return {
        ...stored,
        ownerName: stored.ownerId ? await members.displayNameOf(stored.ownerId) : 'the owner',
        isTurnRunning: (await agentTurns.toolCallTurn(chat.chatId)).promptId !== null,
      }
    },
  )
  if (!ownerId || memberId !== ownerId || isOwnerRemoved) return refused(gitActionRefusalOf(ownerName))
  if (!baseBranch || !checkouts) return refused('This chat has no repository')
  if (isTurnRunning) return refused(turnRunningRefusal)
  const endpoint = await runtimes.endpointOf(chat)
  if (!endpoint) return refused(asleepRefusal)
  try {
    const author = (await checkouts.authorOf(chat, ownerId)) ?? noReplyAuthorOf(ownerName, ownerId)
    return await acts[action]({ ...dependencies, checkouts }, { chat, endpoint, author, baseBranch, message })
  } catch (error) {
    if (error instanceof DomainError) return refused(error.message)
    throw error
  }
}
