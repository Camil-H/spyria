import { type ChatId, messageId, type WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { type AgentEvent, agentProjectionOf } from '../domain/agent-events.ts'
import { observedStep } from '../domain/agent-steps.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { endAgentTurn } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; event: AgentEvent }

export const recordAgentEvent = ({ transactor }: Dependencies, { workspaceId, chatId, event }: Input) =>
  transactor.run(async (unitOfWork) => {
    const activePromptId = await unitOfWork.agentTurns.lock(chatId)
    const previous = await unitOfWork.agentEvents.last(chatId)
    const promptId = activePromptId ?? previous?.replyToId ?? null
    const recordedAt = new Date()
    const seq = await unitOfWork.agentEvents.append(chatId, event, promptId, recordedAt)
    const projection = seq === undefined ? undefined : agentProjectionOf(event, previous?.timestamp ?? null)
    if ((projection?.type === 'message' || projection?.type === 'step') && seq !== undefined)
      await unitOfWork.messages.project(
        newMessage({
          id: messageId(event.id),
          workspaceId,
          chatId,
          kind: projection.type === 'step' ? 'step' : 'agent',
          authorId: null,
          body: MessageBody(projection.type === 'step' ? projection.step.type : projection.body),
          step: projection.type === 'step' ? projection.step : null,
          createdAt: recordedAt,
          replyToId: promptId,
        }),
        seq,
      )
    if (projection?.type === 'step' && projection.step.type === 'plan')
      await unitOfWork.plans.replace(chatId, projection.step.items)
    if (projection?.type === 'observation') {
      const action = await unitOfWork.messages.find(messageId(projection.actionId))
      const step =
        action?.step &&
        observedStep(action.step, projection.observation, recordedAt.getTime() - action.createdAt.getTime())
      if (action && step) await unitOfWork.messages.setStep(action.id, step)
    }
    if (projection?.type === 'turn-end') await endAgentTurn(unitOfWork, chatId, projection.outcome)
    return {
      promptId: projection?.type === 'turn-end' ? null : activePromptId,
      isReplyStored: projection?.type === 'message' || projection?.type === 'step',
    }
  })
