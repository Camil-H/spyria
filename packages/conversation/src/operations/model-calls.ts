import type { MessageId } from '@spyria/kernel'
import type { AgentChat, AgentHost } from '../contracts/agent.ts'
import type { ToolCall } from '../contracts/repositories.ts'
import {
  isContextWindowFailure,
  type ModelCallFailure,
  modelCallNoticeOf,
  publicModelNameOf,
} from '../domain/model-call-failures.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { digestOf } from './decide.ts'
import { noteSubagentFailure } from './delegate-task.ts'

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
  if (runtimeChatId) return { chatId: runtimeChatId, delegationId: undefined, delegationPromptId: undefined }
  const tokenHash = await digestOf(token)
  const delegation = await transactor.run(({ delegations }) => delegations.runningOfTokenHash(host.hostId, tokenHash))
  return (
    delegation && { chatId: delegation.chatId, delegationId: delegation.id, delegationPromptId: delegation.promptId }
  )
}
const isTokenTurn = (tokenChat: { delegationPromptId: MessageId | undefined }, promptId: MessageId | null) =>
  tokenChat.delegationPromptId === undefined || tokenChat.delegationPromptId === promptId

export const findModelCallTurn = async (dependencies: Dependencies, host: AgentHost, token: string) => {
  const tokenChat = await tokenChatOf(dependencies, host, token)
  if (!tokenChat) return undefined
  return dependencies.transactor.run(async ({ agentTurns, members }) => {
    const turn = await agentTurns.modelCallTurn(tokenChat.chatId)
    return (
      turn &&
      isTokenTurn(tokenChat, turn.promptId) && {
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
    const { ownerId, prompterId, promptId } = await agentTurns.toolCallTurn(tokenChat.chatId)
    return (
      ownerId &&
      isTokenTurn(tokenChat, promptId) && {
        chat: { workspaceId: host.workspaceId, chatId: tokenChat.chatId },
        ownerId,
        prompterId,
        promptId,
        ownerName: await members.displayNameOf(ownerId),
        prompterName: prompterId && (await members.displayNameOf(prompterId)),
        delegationId: tokenChat.delegationId,
      }
    )
  })
}

export const recordToolCall = ({ transactor }: Dependencies, call: ToolCall) =>
  transactor.run(({ toolCalls }) => toolCalls.record(call))

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
