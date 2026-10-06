import { type ChatId, type MessageId, messageId } from '@hq/kernel'
import type { UnitOfWork } from '../contracts/transactor.ts'
import { type TurnOutcome, turnEndNoticeOf } from '../domain/agent-events.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

export const appendNotice = ({ messages }: UnitOfWork, prompt: Message, text: string) =>
  messages.record({
    type: 'message.replied',
    actorId: null,
    message: newMessage({
      id: messageId(crypto.randomUUID()),
      workspaceId: prompt.workspaceId,
      chatId: prompt.chatId,
      kind: 'notice',
      authorId: null,
      body: MessageBody(text),
      createdAt: new Date(),
      replyToId: prompt.id,
    }),
  })

export const noticePendingPrompts = async (unitOfWork: UnitOfWork, chatId: ChatId, text: string) => {
  await unitOfWork.agentTurns.lock(chatId)
  for (let prompt = await unitOfWork.agentTurns.nextPrompt(chatId); prompt; ) {
    await appendNotice(unitOfWork, prompt, text)
    prompt = await unitOfWork.agentTurns.nextPrompt(chatId)
  }
}

export const beginAgentTurn = async ({ agentTurns }: UnitOfWork, chatId: ChatId) => {
  if ((await agentTurns.lock(chatId)) !== null) return undefined
  const prompt = await agentTurns.nextPrompt(chatId)
  if (prompt) await agentTurns.set(chatId, prompt.id)
  return prompt
}

export const releaseAgentTurn = async ({ agentTurns }: UnitOfWork, chatId: ChatId, promptId: MessageId) => {
  if ((await agentTurns.lock(chatId)) === promptId) await agentTurns.set(chatId, null)
}

export const endAgentTurn = async (unitOfWork: UnitOfWork, chatId: ChatId, outcome: TurnOutcome) => {
  const { agentTurns, messages, agentPrompts } = unitOfWork
  const promptId = await agentTurns.lock(chatId)
  if (promptId === null) return
  await agentTurns.set(chatId, null)
  const notice = turnEndNoticeOf(outcome, await agentTurns.hasReply(promptId))
  if (notice) await appendNotice(unitOfWork, await messages.get(promptId), notice)
  const next = await agentTurns.nextPrompt(chatId)
  if (next) await agentPrompts.request(next)
}
