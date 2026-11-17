import {
  type ChatId,
  DomainError,
  expiredNoticeOf,
  harnessOf,
  log,
  type MessageId,
  messageId,
  type WorkspaceId,
} from '@spyria/kernel'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import {
  type AgentEvent,
  agentProjectionOf,
  delegatedProjectionOf,
  isAuthRequiredError,
  observedProjectionStep,
  promptJoinedIdOf,
  subagentDelegationOf,
  toolCallIdOf,
  turnEndNoticeOf,
} from '../domain/agent-events.ts'
import type { StepDelegation } from '../domain/agent-steps.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { closeAgentTurn } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor }
const unknownContext = { contextTokens: null, contextWindow: null }
const recordRetryDelaysMilliseconds = [100, 500, 1500]
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
  const replyTarget = activePromptId && !input.turnPromptId ? await unitOfWork.agentTurns.replyTarget(chatId) : null
  const promptId = input.turnPromptId ?? replyTarget ?? activePromptId ?? previous?.replyToId ?? null
  const delegation =
    input.delegation ??
    (toolCallIdOf(event) && promptId
      ? subagentDelegationOf(event, await unitOfWork.messages.openTaskSteps(promptId))
      : undefined)
  const recordedAt = new Date()
  const seq = await unitOfWork.agentEvents.append(chatId, event, promptId, recordedAt, delegation)
  const projected = agentProjectionOf(event)
  const isOwnTurn = (input.turnPromptId ?? activePromptId) === activePromptId
  const joinedPromptId =
    seq !== undefined && !delegation && isOwnTurn && activePromptId ? promptJoinedIdOf(event) : undefined
  const joined = joinedPromptId ? await unitOfWork.messages.find(messageId(joinedPromptId)) : undefined
  if (joined?.chatId === chatId) await unitOfWork.agentTurns.setReplyTarget(chatId, joined.id)
  if (
    seq !== undefined &&
    !delegation &&
    (event.update as { sessionUpdate?: unknown })?.sessionUpdate === 'session_started'
  )
    await unitOfWork.routing.update(chatId, unknownContext)
  const turnEnd =
    seq !== undefined && !delegation && isOwnTurn && projected?.type === 'turn-end' ? projected : undefined
  const isError = seq !== undefined && !delegation && projected?.type === 'step' && projected.step.type === 'error'
  const failure =
    (isError || (turnEnd && previous?.sessionUpdate !== 'error')) && (await unitOfWork.agentTurns.lastFailure(chatId))
  const chat = isError && isAuthRequiredError(event) ? await unitOfWork.chats.get(chatId) : undefined
  const expired = chat?.localSession ? harnessOf(chat.harness) : undefined
  const projection =
    seq === undefined
      ? undefined
      : delegatedProjectionOf(
          failure
            ? { type: 'step', step: { type: 'error', message: failure } }
            : expired
              ? { type: 'step', step: { type: 'error', message: expiredNoticeOf(expired), signIn: expired } }
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
  if (projection?.type === 'observation') {
    const action = await unitOfWork.messages.find(messageId(projection.actionId))
    const step =
      action?.step && observedProjectionStep(action.step, projection, recordedAt.getTime() - action.createdAt.getTime())
    if (action && step) await unitOfWork.messages.setStep(action.id, step)
  }
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
    expiredSignIn: expired,
  }
}

export const recordAgentEvent = ({ transactor }: Dependencies, input: Input) =>
  transactor.run(async (unitOfWork) => recordIn(unitOfWork, await unitOfWork.agentTurns.lock(input.chatId), input))

const recordedWithRetries = async (dependencies: Dependencies, input: Input) => {
  for (const delay of recordRetryDelaysMilliseconds) {
    try {
      return await recordAgentEvent(dependencies, input)
    } catch (error) {
      if (error instanceof DomainError) throw error
      await Bun.sleep(delay)
    }
  }
  return recordAgentEvent(dependencies, input)
}

export const recordAgentEventEndingLostTurns = (dependencies: Dependencies, input: Input) =>
  recordedWithRetries(dependencies, input).catch(async (error: unknown) => {
    const projected = agentProjectionOf(input.event)
    if (error instanceof DomainError || projected?.type !== 'turn-end') throw error
    log.error({
      event: 'agent.turn_end.not_recorded',
      body: 'The end of an agent turn could not be recorded: the turn is closed without it',
      attributes: { 'workspace.id': input.workspaceId, 'chat.id': input.chatId },
      error,
    })
    await dependencies.transactor.run(async (unitOfWork) => {
      const activePromptId = await unitOfWork.agentTurns.lock(input.chatId)
      const promptId = input.turnPromptId ?? activePromptId
      if (promptId)
        await closeAgentTurn(unitOfWork, input.chatId, promptId, (hasReply) =>
          turnEndNoticeOf(projected.outcome, hasReply),
        )
    })
    return { promptId: null, isReplyStored: false, expiredSignIn: undefined }
  })
