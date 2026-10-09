import { chatModelsOf, cheapestModelOf, type MemberId, type MessageId, withPricesOf } from '@hq/kernel'
import type { AgentChat, AgentHost } from '../contracts/agent.ts'
import {
  isContextWindowFailure,
  type ModelCallFailure,
  modelCallNoticeOf,
  publicModelNameOf,
} from '../domain/model-call-failures.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { digestOf } from './decide.ts'
import { noteSubagentFailure } from './delegate.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes' | 'classifier'>
type FailedCall = {
  chat: AgentChat
  promptId: MessageId
  prompterName: string
  model: string | undefined
  failure: ModelCallFailure
  delegationId?: string
}

export const findModelCallTurn = async ({ transactor, runtimes }: Dependencies, host: AgentHost, token: string) => {
  const runtimeChatId = await runtimes.chatOfLlmToken(host, token)
  const tokenHash = runtimeChatId ? '' : await digestOf(token)
  return transactor.run(async ({ agentTurns, members, delegations }) => {
    const delegation = runtimeChatId ? undefined : await delegations.runningOfTokenHash(host.hostId, tokenHash)
    const chatId = runtimeChatId ?? delegation?.chatId
    const turn = chatId && (await agentTurns.modelCallTurn(chatId))
    return (
      chatId &&
      turn && {
        ...turn,
        chat: { workspaceId: host.workspaceId, chatId },
        prompterName: await members.displayNameOf(turn.prompterId),
        delegationId: delegation?.id,
      }
    )
  })
}

export const findToolCallTurn = async ({ transactor, runtimes }: Dependencies, host: AgentHost, token: string) => {
  const chatId = await runtimes.chatOfLlmToken(host, token)
  if (!chatId) return undefined
  return transactor.run(async ({ agentTurns, members }) => {
    const { ownerId, prompterId } = await agentTurns.toolCallTurn(chatId)
    return (
      ownerId && {
        chat: { workspaceId: host.workspaceId, chatId },
        ownerId,
        prompterId,
        ownerName: await members.displayNameOf(ownerId),
      }
    )
  })
}

export const recordModelCallFailure = async (
  { transactor }: Dependencies,
  { chat, promptId, prompterName, model, failure, delegationId }: FailedCall,
) => {
  const notice = modelCallNoticeOf(failure, { memberName: prompterName, model: publicModelNameOf(model) })
  if (isContextWindowFailure(failure)) return notice
  if (delegationId) return noteSubagentFailure(delegationId, notice)
  return transactor.run(async ({ agentTurns }) => {
    await agentTurns.recordFailure(chat.chatId, promptId, notice)
    return notice
  })
}

export const findCondenserModel = async ({ transactor, classifier }: Dependencies, prompterId: MemberId) => {
  const reachable = (await transactor.run(({ routing }) => routing.reachableModels(prompterId))) ?? []
  return cheapestModelOf(chatModelsOf(withPricesOf(reachable, classifier?.listedModels() ?? [])))?.id
}
