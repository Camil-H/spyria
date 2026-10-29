import type { ChatId, MessageId } from '@spyria/kernel'
import type { AgentConversation } from '../contracts/agent.ts'

export type DelegationResult = { text: string; isError: boolean }
export type RunningDelegation = {
  chatId: ChatId
  promptId: MessageId
  result: Promise<DelegationResult>
  failure?: string
  conversation?: AgentConversation
  isSettled?: boolean
  isCancelled?: boolean
}

export const runningDelegations = new Map<string, RunningDelegation>()

export const forgetDelegationsOf = (promptId: MessageId) => {
  for (const [id, running] of runningDelegations) if (running.promptId === promptId) runningDelegations.delete(id)
}
