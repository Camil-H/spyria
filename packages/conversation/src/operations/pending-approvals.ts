import type { MemberId, MessageId } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolCallDecision } from '../contracts/repositories.ts'

export type Decided = { decision: Exclude<ToolCallDecision, 'not_needed'>; decidedBy: MemberId | null }
type PendingApproval = {
  chat: AgentChat
  promptId: MessageId | null
  ownerId: MemberId
  decide: (decided: Decided) => void
}

export const pendingApprovals = new Map<string, PendingApproval>()

export const cancelToolApprovalsOf = (promptId: MessageId) => {
  for (const pending of pendingApprovals.values())
    if (pending.promptId === promptId) pending.decide({ decision: 'cancelled', decidedBy: null })
}
