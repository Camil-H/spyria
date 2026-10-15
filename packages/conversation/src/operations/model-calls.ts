import type { MessageId } from '@hq/kernel'
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

const tokenChatOf = async ({ transactor, runtimes }: Dependencies, host: AgentHost, token: string) => {
  const runtimeChatId = await runtimes.chatOfLlmToken(host, token)
  if (runtimeChatId) return { chatId: runtimeChatId, delegationId: undefined }
  const tokenHash = await digestOf(token)
  const delegation = await transactor.run(({ delegations }) => delegations.runningOfTokenHash(host.hostId, tokenHash))
  return delegation && { chatId: delegation.chatId, delegationId: delegation.id }
}

export const findModelCallTurn = async (dependencies: Dependencies, host: AgentHost, token: string) => {
  const tokenChat = await tokenChatOf(dependencies, host, token)
  if (!tokenChat) return undefined
  return dependencies.transactor.run(async ({ agentTurns, members }) => {
    const turn = await agentTurns.modelCallTurn(tokenChat.chatId)
    return (
      turn && {
        ...turn,
        chat: { workspaceId: host.workspaceId, chatId: tokenChat.chatId },
        prompterName: await members.displayNameOf(turn.prompterId),
        delegationId: tokenChat.delegationId,
      }
    )
  })
}

export const findToolCallTurn = async (dependencies: Dependencies, host: AgentHost, token: string) => {
  const tokenChat = await tokenChatOf(dependencies, host, token)
  if (!tokenChat) return undefined
  return dependencies.transactor.run(async ({ agentTurns, members }) => {
    const { ownerId, prompterId } = await agentTurns.toolCallTurn(tokenChat.chatId)
    return (
      ownerId && {
        chat: { workspaceId: host.workspaceId, chatId: tokenChat.chatId },
        ownerId,
        prompterId,
        ownerName: await members.displayNameOf(ownerId),
        delegationId: tokenChat.delegationId,
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
