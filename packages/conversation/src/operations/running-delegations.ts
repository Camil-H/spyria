import type { ChatId, MessageId } from '@hq/kernel'

export type DelegationResult = { text: string; isError: boolean }
export type RunningDelegation = {
  chatId: ChatId
  promptId: MessageId
  result: Promise<DelegationResult>
  failure?: string
}

export const runningDelegations = new Map<string, RunningDelegation>()

export const forgetDelegationsOf = (promptId: MessageId) => {
  for (const [id, running] of runningDelegations) if (running.promptId === promptId) runningDelegations.delete(id)
}
