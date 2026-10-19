import { type ChatId, type MessageId, messageId, type WorkspaceId } from '@spyria/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import {
  type AgentEvent,
  agentProjectionOf,
  delegatedProjectionOf,
  isAuthRequiredError,
  isPlanningOf,
  observedProjectionStep,
  subagentDelegationOf,
  toolCallIdOf,
  turnEndNoticeOf,
} from '../domain/agent-events.ts'
import type { StepDelegation } from '../domain/agent-steps.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { localSessions } from '../domain/session-routing.ts'
import { closeAgentTurn } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = {
  workspaceId: WorkspaceId
  chatId: ChatId
  event: AgentEvent
  delegation?: StepDelegation
  turnPromptId?: MessageId
}

const recordIn = async (
  unitOfWork: UnitOfWork,
  activePromptId: MessageId | null,
  { workspaceId, chatId, event, ...input }: Input,
) => {
  const previous = await unitOfWork.agentEvents.last(chatId)
  const promptId = input.turnPromptId ?? activePromptId ?? previous?.replyToId ?? null
  const delegation =
    input.delegation ??
    (toolCallIdOf(event) && promptId
      ? subagentDelegationOf(event, await unitOfWork.messages.replies(promptId))
      : undefined)
  const recordedAt = new Date()
  const seq = await unitOfWork.agentEvents.append(chatId, event, promptId, recordedAt, delegation)
  const projected = agentProjectionOf(event)
  const isOwnTurn = (input.turnPromptId ?? activePromptId) === activePromptId
  const turnEnd =
    seq !== undefined && !delegation && isOwnTurn && projected?.type === 'turn-end' ? projected : undefined
  const isError = seq !== undefined && !delegation && projected?.type === 'step' && projected.step.type === 'error'
  const failure =
    (isError || (turnEnd && previous?.sessionUpdate !== 'error')) && (await unitOfWork.agentTurns.lastFailure(chatId))
  const chat = isError && isAuthRequiredError(event) ? await unitOfWork.chats.get(chatId) : undefined
  const expired = chat?.localSession ? localSessions[chat.harness ?? 'claude-code'] : undefined
  const projection =
    seq === undefined
      ? undefined
      : delegatedProjectionOf(
          failure
            ? { type: 'step', step: { type: 'error', message: failure } }
            : expired
              ? { type: 'step', step: { type: 'error', message: expired.expiredNotice, signIn: expired.signIn } }
              : projected,
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
  const isPlanning = seq !== undefined && !delegation ? isPlanningOf(event) : undefined
  if (isPlanning !== undefined) await unitOfWork.chats.setPlanning(chatId, isPlanning)
  const endsSignedOut =
    turnEnd &&
    previous?.sessionUpdate === 'error' &&
    promptId &&
    (await unitOfWork.messages.replies(promptId)).some((reply) => reply.step?.type === 'error' && reply.step.signIn)
  if (turnEnd && activePromptId)
    await closeAgentTurn(unitOfWork, chatId, activePromptId, (hasReply) =>
      endsSignedOut ? undefined : turnEndNoticeOf(turnEnd.outcome, hasReply),
    )
  return {
    promptId: turnEnd ? null : activePromptId,
    isReplyStored: projection?.type === 'message' || projection?.type === 'step',
    expiredSignIn: expired?.signIn,
  }
}

export const recordAgentEvent = ({ transactor }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork) => recordIn(unitOfWork, await unitOfWork.agentTurns.lock(input.chatId), input))
