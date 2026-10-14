import { type ChatId, type MessageId, messageId, type WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import {
  type AgentEvent,
  agentProjectionOf,
  delegatedProjectionOf,
  observedProjectionStep,
  subagentDelegationOf,
  toolCallIdOf,
} from '../domain/agent-events.ts'
import type { StepDelegation } from '../domain/agent-steps.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { endAgentTurn } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = {
  workspaceId: WorkspaceId
  chatId: ChatId
  event: AgentEvent
  delegation?: StepDelegation
}

const recordIn = async (
  unitOfWork: UnitOfWork,
  activePromptId: MessageId | null,
  { workspaceId, chatId, event, ...input }: Input,
) => {
  const previous = await unitOfWork.agentEvents.last(chatId)
  const promptId = activePromptId ?? previous?.replyToId ?? null
  const delegation =
    input.delegation ??
    (toolCallIdOf(event) && promptId
      ? subagentDelegationOf(event, await unitOfWork.messages.replies(promptId))
      : undefined)
  const recordedAt = new Date()
  const seq = await unitOfWork.agentEvents.append(chatId, event, promptId, recordedAt, delegation)
  const projected = agentProjectionOf(event)
  const turnEnd = seq !== undefined && !delegation && projected?.type === 'turn-end' ? projected : undefined
  const failure = turnEnd && (await unitOfWork.agentTurns.lastFailure(chatId))
  const projection =
    seq === undefined
      ? undefined
      : delegatedProjectionOf(
          failure ? { type: 'step', step: { type: 'error', message: failure } } : projected,
          delegation,
        )
  if ((projection?.type === 'message' || projection?.type === 'step') && seq !== undefined)
    await unitOfWork.messages.project(
      newMessage({
        id: messageId((projection.type === 'step' && projection.id) || event.id),
        workspaceId,
        chatId,
        kind: projection.type === 'step' ? 'step' : (projection.kind ?? 'agent'),
        authorId: null,
        body: MessageBody(projection.type === 'step' ? projection.step.type : projection.body),
        step: projection.type === 'step' ? projection.step : (projection.thought ?? null),
        createdAt: recordedAt,
        replyToId: promptId,
      }),
      seq,
    )
  if (projection?.type === 'step' && projection.step.type === 'plan' && !delegation)
    await unitOfWork.plans.replace(chatId, projection.step.items)
  if (projection?.type === 'observation') {
    const action = await unitOfWork.messages.find(messageId(projection.actionId))
    const step =
      action?.step && observedProjectionStep(action.step, projection, recordedAt.getTime() - action.createdAt.getTime())
    if (action && step) await unitOfWork.messages.setStep(action.id, step)
  }
  if (turnEnd) await endAgentTurn(unitOfWork, chatId, turnEnd.outcome)
  return {
    promptId: turnEnd ? null : activePromptId,
    isReplyStored: projection?.type === 'message' || projection?.type === 'step',
  }
}

export const recordAgentEvent = ({ transactor }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork) => recordIn(unitOfWork, await unitOfWork.agentTurns.lock(input.chatId), input))
