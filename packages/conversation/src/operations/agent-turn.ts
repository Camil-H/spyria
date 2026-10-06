import { type ChatId, type MessageId, messageId } from '@hq/kernel'
import type { AgentEventSockets, AgentRuntimes, AgentServer } from '../contracts/agent.ts'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { type TurnOutcome, turnEndNoticeOf } from '../domain/agent-events.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'

type NoticeOf = (hasReply: boolean) => string | undefined
export type AgentDependencies = {
  transactor: ConversationTransactor
  runtimes: AgentRuntimes
  agentServer: AgentServer
  eventSockets: AgentEventSockets
}

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

export const noticeWaitingPrompts = async (unitOfWork: UnitOfWork, chatId: ChatId, text: string) => {
  await unitOfWork.agentTurns.lock(chatId)
  for (const prompt of await unitOfWork.agentTurns.waitingPrompts(chatId))
    if (!(await unitOfWork.agentTurns.hasNotice(prompt.id, text))) await appendNotice(unitOfWork, prompt, text)
}

export const requestNextPrompt = async ({ agentTurns, agentJobs }: UnitOfWork, chatId: ChatId) => {
  const next = await agentTurns.nextPrompt(chatId)
  if (next) await agentJobs.prompt(next)
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

const finishAgentTurn = async (unitOfWork: UnitOfWork, chatId: ChatId, promptId: MessageId, noticeOf: NoticeOf) => {
  await unitOfWork.agentTurns.set(chatId, null)
  const notice = noticeOf(await unitOfWork.agentTurns.hasReply(promptId))
  if (notice) await appendNotice(unitOfWork, await unitOfWork.messages.get(promptId), notice)
  await requestNextPrompt(unitOfWork, chatId)
}

export const endAgentTurn = async (unitOfWork: UnitOfWork, chatId: ChatId, outcome: TurnOutcome) => {
  const promptId = await unitOfWork.agentTurns.lock(chatId)
  if (promptId !== null)
    await finishAgentTurn(unitOfWork, chatId, promptId, (hasReply) => turnEndNoticeOf(outcome, hasReply))
}

export const closeAgentTurn = async (
  unitOfWork: UnitOfWork,
  chatId: ChatId,
  promptId: MessageId,
  noticeOf: NoticeOf,
) => {
  if ((await unitOfWork.agentTurns.lock(chatId)) === promptId)
    await finishAgentTurn(unitOfWork, chatId, promptId, noticeOf)
}
