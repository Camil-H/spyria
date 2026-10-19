import type { MemberId, MessageId } from '@spyria/kernel'
import type { AgentChat } from '../contracts/agent.ts'
import type { ToolApproval } from '../domain/agent-steps.ts'
import { toolApprovalWindowMilliseconds } from '../domain/tool-calls.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { type Decided, pendingApprovals } from './pending-approvals.ts'
import { recordAgentEvent } from './record-agent-event.ts'

type Input = {
  chat: AgentChat
  promptId: MessageId | null
  ownerId: MemberId
  approval: ToolApproval
  signal?: AbortSignal
}

const forbiddenStatus = 403
const invalidStatus = 400

export const requestToolApproval = async (
  { transactor, eventSockets, approvalWindowMilliseconds = toolApprovalWindowMilliseconds }: AgentDependencies,
  { chat, promptId, ownerId, approval, signal }: Input,
): Promise<Decided> => {
  const question = { questionId: crypto.randomUUID(), kind: 'approval' as const, approval }
  const decided = Promise.withResolvers<Decided>()
  const decide = (outcome: Decided) => {
    pendingApprovals.delete(question.questionId)
    decided.resolve(outcome)
  }
  const cancel = () => decide({ decision: 'cancelled', decidedBy: null })
  pendingApprovals.set(question.questionId, { chat, promptId, ownerId, decide })
  eventSockets.showQuestion(chat, { promptId: promptId ?? '', question: { sessionUpdate: 'question', ...question } })
  const timer = setTimeout(() => decide({ decision: 'expired', decidedBy: null }), approvalWindowMilliseconds)
  signal?.addEventListener('abort', cancel)
  if (signal?.aborted) cancel()
  const outcome = await decided.promise
  clearTimeout(timer)
  signal?.removeEventListener('abort', cancel)
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
