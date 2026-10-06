import { type ChatId, messageId, type WorkspaceId } from '@hq/kernel'
import type { ConversationTransactor } from '../contracts/transactor.ts'
import { type AgentEvent, agentProjectionOf } from '../domain/agent-events.ts'
import { newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { endAgentTurn } from './agent-turn.ts'

type Dependencies = { transactor: ConversationTransactor }
type Input = { workspaceId: WorkspaceId; chatId: ChatId; event: AgentEvent }

export const recordAgentEvent = ({ transactor }: Dependencies, { workspaceId, chatId, event }: Input) =>
  transactor.run(async (unitOfWork) => {
    const promptId = await unitOfWork.agentTurns.lock(chatId)
    const recordedAt = new Date()
    const seq = await unitOfWork.agentEvents.append(chatId, event, promptId, recordedAt)
    const projection = seq === undefined ? undefined : agentProjectionOf(event)
    if (projection?.type === 'message' && seq !== undefined)
      await unitOfWork.messages.project(
        newMessage({
          id: messageId(event.id),
          workspaceId,
          chatId,
          kind: projection.kind,
          authorId: null,
          body: MessageBody(projection.body),
          createdAt: recordedAt,
          replyToId: promptId,
        }),
        seq,
      )
    if (projection?.type === 'detail')
      await unitOfWork.messages.setDetail(messageId(projection.actionId), projection.detail)
    if (projection?.type === 'turn-end') await endAgentTurn(unitOfWork, chatId, projection.outcome)
    return {
      promptId: projection?.type === 'turn-end' ? null : promptId,
      isReplyStored: projection?.type === 'message',
    }
  })
