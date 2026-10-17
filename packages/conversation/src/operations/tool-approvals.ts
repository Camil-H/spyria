import type { MemberId, MessageId } from '@hq/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolCallDecision } from '../contracts/repositories.ts'
import type { ToolApproval } from '../domain/agent-steps.ts'
import { toolApprovalWindowMilliseconds } from '../domain/tool-calls.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { recordAgentEvent } from './record-agent-event.ts'

type Decided = { decision: Exclude<ToolCallDecision, 'not_needed'>; decidedBy: MemberId | null }
type PendingApproval = { chat: AgentChat; ownerId: MemberId; decide: (decided: Decided) => void }
type Input = { chat: AgentChat; promptId: MessageId | null; ownerId: MemberId; approval: ToolApproval }

const forbiddenStatus = 403
const invalidStatus = 400
const pendingApprovals = new Map<string, PendingApproval>()

export const requestToolApproval = async (
  { transactor, eventSockets, approvalWindowMilliseconds = toolApprovalWindowMilliseconds }: AgentDependencies,
  { chat, promptId, ownerId, approval }: Input,
): Promise<Decided> => {
  const question = { questionId: crypto.randomUUID(), kind: 'approval' as const, approval }
  const decided = Promise.withResolvers<Decided>()
  const decide = (outcome: Decided) => {
    pendingApprovals.delete(question.questionId)
    decided.resolve(outcome)
  }
  pendingApprovals.set(question.questionId, { chat, ownerId, decide })
  eventSockets.showQuestion(chat, { promptId: promptId ?? '', question: { sessionUpdate: 'question', ...question } })
  const timer = setTimeout(() => decide({ decision: 'expired', decidedBy: null }), approvalWindowMilliseconds)
  const outcome = await decided.promise
  clearTimeout(timer)
  const isAnswered = outcome.decision === 'approved' || outcome.decision === 'denied'
  const update = isAnswered
    ? {
        sessionUpdate: 'question_answered',
        ...question,
        approved: outcome.decision === 'approved',
        answeredBy: outcome.decidedBy,
      }
    : { sessionUpdate: 'question_closed', ...question, reason: outcome.decision === 'expired' ? 'expired' : 'stopped' }
  const event = {
    id: crypto.randomUUID(),
    kind: 'ACPUpdate',
    timestamp: new Date().toISOString(),
    completed: true,
    update,
  }
  await recordAgentEvent({ transactor }, { ...chat, event, turnPromptId: promptId ?? undefined }).catch((error) =>
    console.error(`Recording a tool approval of chat ${chat.chatId} failed: ${error}`),
  )
  eventSockets.hideQuestion(chat, question.questionId)
  return outcome
}

export const answerToolApproval = (chat: AgentChat, memberId: MemberId, questionId: string, answer: object) => {
  const pending = pendingApprovals.get(questionId)
  if (pending?.chat.chatId !== chat.chatId || pending.chat.workspaceId !== chat.workspaceId) return undefined
  if (pending.ownerId !== memberId) return forbiddenStatus
  const { approve } = answer as { approve?: unknown }
  if (typeof approve !== 'boolean') return invalidStatus
  pending.decide({ decision: approve ? 'approved' : 'denied', decidedBy: memberId })
  return 200
}

export const cancelToolApprovals = (chat: AgentChat) => {
  for (const pending of pendingApprovals.values())
    if (pending.chat.chatId === chat.chatId && pending.chat.workspaceId === chat.workspaceId)
      pending.decide({ decision: 'cancelled', decidedBy: null })
}
