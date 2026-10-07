import type { MessageId } from '@hq/kernel'
import type { AgentChat, AgentHost } from '../contracts/agent.ts'
import { type ModelCallFailure, modelCallNoticeOf, publicModelNameOf } from '../domain/model-call-failures.ts'
import type { AgentDependencies } from './agent-turn.ts'

type Dependencies = Pick<AgentDependencies, 'transactor' | 'runtimes'>
type FailedCall = {
  chat: AgentChat
  promptId: MessageId
  prompterName: string
  model: string | undefined
  failure: ModelCallFailure
}

export const findModelCallTurn = async ({ transactor, runtimes }: Dependencies, host: AgentHost, token: string) => {
  const chatId = await runtimes.chatOfLlmToken(host, token)
  if (!chatId) return undefined
  return transactor.run(async ({ agentTurns, members }) => {
    const turn = await agentTurns.modelCallTurn(chatId)
    return (
      turn && {
        ...turn,
        chat: { workspaceId: host.workspaceId, chatId },
        prompterName: await members.displayNameOf(turn.prompterId),
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

export const recordModelCallFailure = (
  { transactor }: Dependencies,
  { chat, promptId, prompterName, model, failure }: FailedCall,
) => {
  const notice = modelCallNoticeOf(failure, { memberName: prompterName, model: publicModelNameOf(model) })
  return transactor.run(async ({ agentTurns }) => {
    await agentTurns.recordFailure(chat.chatId, promptId, notice)
    return notice
  })
}
