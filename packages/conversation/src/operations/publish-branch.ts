import { DomainError, type MemberId, type MessageId, messageId, requireChatPermission } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import type { PullRequestChange } from '../domain/github-tools.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import {
  isOpenPullRequest,
  noGitHubConnection,
  type PublishAction,
  type PullRequestDraft,
  type PullRequestStep,
  publishingRefusalOf,
} from '../domain/pull-requests.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes' | 'agentClient' | 'checkouts'>
type Input = { chat: AgentChat; memberId: MemberId; action: PublishAction; draft: PullRequestDraft }
export type Publication = { isRefused: boolean; text: string }

const refused = (text: string): Publication => ({ isRefused: true, text })

export const recordPullRequest = (
  { transactor }: { transactor: ConversationTransactor },
  {
    chat,
    actorId,
    step,
    cardId,
  }: { chat: AgentChat; actorId: MemberId | null; step: PullRequestStep; cardId?: MessageId },
) =>
  transactor.run(async ({ messages }) => {
    if (cardId)
      return messages.record({
        type: 'message.step_changed',
        actorId,
        message: { ...(await messages.get(cardId)), step },
      })
    await messages.record({
      type: 'message.posted',
      actorId,
      message: newMessage({
        id: messageId(crypto.randomUUID()),
        workspaceId: chat.workspaceId,
        chatId: chat.chatId,
        kind: 'step',
        authorId: actorId,
        body: MessageBody(step.type),
        step,
        createdAt: new Date(),
        replyToId: null,
      }),
    })
  })

const pushAndRecord = async (
  { runtimes, agentClient, checkouts, transactor }: Required<Dependencies>,
  { chat, ownerId, action, card, draft }: Omit<Input, 'memberId'> & { ownerId: MemberId; card: Message | undefined },
): Promise<Publication> => {
  const pushed = await checkouts.pushBranch(chat, ownerId, async (branch, prerequisite) => {
    const endpoint = await runtimes.endpointOf(chat)
    return endpoint
      ? agentClient.bundleBranch(endpoint, branch, prerequisite)
      : { failure: 'The runtime is asleep: wake it, then push again' }
  })
  if (!pushed) return refused(noGitHubConnection)
  if (pushed.failure) return refused(pushed.failure)
  await transactor.run(({ chats }) =>
    chats.recordPush({ chatId: chat.chatId, actorId: ownerId, branch: pushed.branch, head: pushed.head ?? null }),
  )
  const endpoint = pushed.head && (await runtimes.endpointOf(chat))
  if (endpoint) await agentClient.actOnWorkspace(endpoint, 'pushed', { head: pushed.head })
  const pullRequest = card?.step?.type === 'pull_request' ? card.step : undefined
  const openPullRequest = pullRequest && isOpenPullRequest(pullRequest) ? pullRequest : undefined
  if (!openPullRequest && action === 'push') return { isRefused: false, text: `Pushed ${pushed.branch}` }
  const step = openPullRequest
    ? await checkouts.refreshPullRequest(chat, ownerId, openPullRequest)
    : await checkouts.openPullRequest(chat, ownerId, draft)
  await recordPullRequest({ transactor }, { chat, actorId: ownerId, step, cardId: openPullRequest && card?.id })
  return {
    isRefused: false,
    text: openPullRequest
      ? `Pushed ${pushed.branch} to pull request #${step.number} (${step.commits} commits): ${step.url}`
      : `Opened pull request #${step.number}: ${step.url}`,
  }
}

const publishingChatOf = ({ transactor }: Pick<Dependencies, 'transactor'>, chat: AgentChat, memberId: MemberId) =>
  transactor.run(async ({ chats, members, messages }) => {
    await requireChatPermission(chats, chat.chatId, memberId, 'chat.read')
    const stored = await chats.get(chat.chatId)
    const ownerName = stored.ownerId ? await members.displayNameOf(stored.ownerId) : 'the owner'
    const publisherId = stored.ownerId === memberId && !stored.isOwnerRemoved ? stored.ownerId : undefined
    return { ...stored, ownerName, publisherId, card: await messages.pullRequestCard(chat.chatId) }
  })

const refusedOnDomainError = (error: unknown) => {
  if (error instanceof DomainError) return refused(error.message)
  throw error
}

export const publishBranch = async (dependencies: Dependencies, { chat, memberId, action, draft }: Input) => {
  const { checkouts } = dependencies
  const { publisherId, ownerName, baseBranch, name, card } = await publishingChatOf(dependencies, chat, memberId)
  if (!publisherId) return refused(publishingRefusalOf(ownerName))
  if (!baseBranch || !checkouts) return refused('This chat has no repository')
  return pushAndRecord(
    { ...dependencies, checkouts },
    { chat, ownerId: publisherId, action, card, draft: { ...draft, title: draft.title.trim() || name } },
  ).catch(refusedOnDomainError)
}

export const updatePullRequest = async (
  dependencies: Dependencies,
  { chat, memberId, change }: { chat: AgentChat; memberId: MemberId; change: PullRequestChange },
): Promise<Publication> => {
  const { transactor, checkouts } = dependencies
  const { publisherId, ownerName, baseBranch, card } = await publishingChatOf(dependencies, chat, memberId)
  if (!publisherId) return refused(publishingRefusalOf(ownerName))
  if (!baseBranch || !checkouts) return refused('This chat has no repository')
  const pullRequest = card?.step?.type === 'pull_request' && isOpenPullRequest(card.step) ? card.step : undefined
  if (!card || !pullRequest) return refused('This chat has no open pull request: open one first')
  try {
    const step = await checkouts.updatePullRequest(chat, publisherId, pullRequest, change)
    await recordPullRequest({ transactor }, { chat, actorId: publisherId, step, cardId: card.id })
    return { isRefused: false, text: `Updated pull request #${step.number}: ${step.url}` }
  } catch (error) {
    return refusedOnDomainError(error)
  }
}
