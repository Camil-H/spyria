import { type ChatId, can, type MessageId, messageId } from '@spyria/kernel'
import type {
  AgentClient,
  AgentEventSockets,
  AgentRuntimes,
  RepositoryCheckouts,
  SessionClassifier,
} from '../contracts/agent.ts'
import type { ConversationTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { expiredPromptNotice, hasOutlivedWait, unavailableNotices } from '../domain/agent-events.ts'
import { type Message, newMessage } from '../domain/message.ts'
import { MessageBody } from '../domain/message-body.ts'
import { noLlmKeyNoticeOf, noLongerPromptsNoticeOf } from '../domain/model-call-failures.ts'
import { cancelToolApprovalsOf } from './pending-approvals.ts'
import { forgetDelegationsOf } from './running-delegations.ts'

type NoticeOf = (hasReply: boolean) => string | undefined
export type AgentDependencies = {
  transactor: ConversationTransactor
  runtimes: AgentRuntimes
  agentClient: AgentClient
  eventSockets: AgentEventSockets
  classifier?: SessionClassifier
  checkouts?: RepositoryCheckouts
  fixedLlm?: { model: string }
  resumeAfterMilliseconds?: number
  approvalWindowMilliseconds?: number
  deployment?: string
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
    if (!(await unitOfWork.agentTurns.hasNotice(prompt.id, [text]))) await appendNotice(unitOfWork, prompt, text)
}

export const requestNextPrompt = async ({ agentTurns, agentJobs }: UnitOfWork, chatId: ChatId) => {
  const next = await agentTurns.nextPrompt(chatId)
  if (next) await agentJobs.prompt(next)
}

export const beginAgentTurn = async (
  unitOfWork: UnitOfWork,
  chatId: ChatId,
  resumesHeldTurn = false,
): Promise<Message | undefined> => {
  const { agentTurns, members } = unitOfWork
  const heldPromptId = await agentTurns.lock(chatId)
  if (heldPromptId !== null) return resumesHeldTurn ? unitOfWork.messages.get(heldPromptId) : undefined
  const prompt = await agentTurns.nextPrompt(chatId)
  if (prompt && hasOutlivedWait(prompt, Date.now()) && (await agentTurns.hasNotice(prompt.id, unavailableNotices))) {
    await appendNotice(unitOfWork, prompt, expiredPromptNotice)
    return beginAgentTurn(unitOfWork, chatId)
  }
  if (prompt?.authorId && !can(await unitOfWork.chats.permissions(chatId, prompt.authorId), 'chat.post')) {
    await appendNotice(unitOfWork, prompt, noLongerPromptsNoticeOf(await members.displayNameOf(prompt.authorId)))
    return beginAgentTurn(unitOfWork, chatId)
  }
  const needsLlmKey = !(await unitOfWork.chats.get(chatId)).localSession
  if (prompt?.authorId && needsLlmKey && !(await members.hasLlmCredential(prompt.authorId))) {
    await appendNotice(unitOfWork, prompt, noLlmKeyNoticeOf(await members.displayNameOf(prompt.authorId)))
    return beginAgentTurn(unitOfWork, chatId)
  }
  if (prompt) await agentTurns.set(chatId, prompt)
  return prompt
}

export const releaseAgentTurn = async ({ agentTurns }: UnitOfWork, chatId: ChatId) => {
  if ((await agentTurns.lock(chatId)) !== null) await agentTurns.set(chatId, null)
}

const finishAgentTurn = async (unitOfWork: UnitOfWork, chatId: ChatId, promptId: MessageId, noticeOf: NoticeOf) => {
  await unitOfWork.agentTurns.set(chatId, null)
  await unitOfWork.delegations.stopRunning(chatId, promptId)
  forgetDelegationsOf(promptId)
  cancelToolApprovalsOf(promptId)
  const notice = noticeOf(await unitOfWork.agentTurns.hasReply(promptId))
  if (notice) await appendNotice(unitOfWork, await unitOfWork.messages.get(promptId), notice)
  await requestNextPrompt(unitOfWork, chatId)
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
