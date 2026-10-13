import { chatModelsOf, type MemberId, type MessageId, type WorkspaceId } from '@hq/kernel'
import type { AgentChat, AgentConversation, AgentEndpoint, RuntimeReadiness } from '../contracts/agent.ts'
import { agentNotices, notReadyNoticeOf } from '../domain/agent-events.ts'
import type { Message } from '../domain/message.ts'
import { noLlmKeyNoticeOf } from '../domain/model-call-failures.ts'
import {
  type HarnessLaunch,
  harnesses,
  harnessOfKeys,
  type LocalSession,
  localSessions,
  reachesHarness,
  sessionChoiceOf,
  sessionQuestions,
  sessionStateOf,
  unreachableSessionNoticeOf,
} from '../domain/session-routing.ts'
import {
  type AgentDependencies,
  appendNotice,
  beginAgentTurn,
  closeAgentTurn,
  noticeWaitingPrompts,
  releaseAgentTurn,
} from './agent-turn.ts'
import { decide } from './decide.ts'

type Input = { workspaceId: WorkspaceId; messageId: MessageId }
type Prepared = { conversation: AgentConversation } | { refusal: string }

const runtimeStartPollMilliseconds = 500
export const agentLlmOf = (model: string, effort: string | null, usageId = 'agent') => ({
  model: `openai/${model}`,
  effort: effort ?? undefined,
  usageId,
})

const routeSession = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  prompterId: MemberId,
  prompt: Message,
) => {
  const { routing, reachable } = await dependencies.transactor.run(async ({ routing }) => ({
    routing: await routing.chatRouting(chat.chatId),
    reachable: (await routing.reachableModels(prompterId)) ?? [],
  }))
  const harness = routing.harness ?? harnessOfKeys(reachable)
  if (harness) return { harness, canPrompt: reachesHarness(harness, reachable) }
  const decision = await decide(dependencies, {
    models: reachable,
    chat,
    prompterId,
    ownerId: routing.ownerId,
    state: sessionStateOf(prompt.body, routing.mode),
    questions: sessionQuestions,
  })
  const choice = sessionChoiceOf({ reachable, defaultModel: routing.defaultModel, answers: decision?.answers })
  return {
    choice: choice && { ...choice, reason: decision ? choice.reason : 'routing unavailable' },
    answers: decision?.answers,
    costMicros: decision?.costMicros ?? 0,
    inputsDigest: decision?.inputsDigest ?? null,
  }
}

const keepSession = async (
  { transactor, runtimes, agentServer }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
  prompterId: MemberId,
): Promise<Prepared> => {
  const { routing, reachable } = await transactor.run(async ({ routing }) => ({
    routing: await routing.chatRouting(chat.chatId),
    reachable: await routing.reachableModels(prompterId),
  }))
  const { model, reasoningEffort, agentModel, harness } = routing
  if (harness)
    return reachesHarness(harness, reachable ?? []) ? { conversation } : { refusal: harnesses[harness].keysNotice }
  if (!model) return { conversation }
  if (!chatModelsOf(reachable ?? []).some((candidate) => candidate.id === model))
    return { refusal: unreachableSessionNoticeOf(model) }
  if (agentModel !== model) {
    const llmToken = await runtimes.issueLlmToken(chat, true)
    await agentServer.switchLlm(
      conversation,
      llmToken,
      agentLlmOf(model, reasoningEffort, `agent:${crypto.randomUUID()}`),
    )
    await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model))
  }
  return { conversation }
}

const keepAcpModel = async (
  { transactor, agentServer }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
): Promise<Prepared> => {
  const { model, agentModel } = await transactor.run(({ routing }) => routing.chatRouting(chat.chatId))
  if (model && model !== agentModel) {
    await agentServer.switchAcpModel(conversation, model)
    await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model))
  }
  return { conversation }
}

const harnessConversationFor = async (
  { transactor, runtimes, agentServer }: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  { launch, model, acpModel }: { launch: HarnessLaunch; model: string; acpModel?: string },
): Promise<AgentConversation> => {
  const resumeSessionId = endpoint.isHqAgent
    ? await transactor.run(({ agentEvents }) => agentEvents.lastSessionId(chat.chatId))
    : endpoint.conversationId === null
      ? await transactor.run(({ agentEvents }) => agentEvents.stoppedHarnessSessionId(chat.chatId))
      : undefined
  const runtimeToken = await runtimes.issueLlmToken(chat)
  const conversationId = await runtimes.rememberConversation(
    chat,
    await agentServer.createConversation(endpoint, runtimeToken, {
      model,
      usageId: 'agent',
      harness: launch,
      resumeSessionId,
      acpModel,
    }),
  )
  if (acpModel) await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, acpModel))
  return { ...endpoint, conversationId }
}

const conversationFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  { endpoint, signedIn }: Extract<RuntimeReadiness, { state: 'ready' }>,
  prompt: Message,
  localSession: LocalSession | undefined,
): Promise<Prepared> => {
  const { transactor, runtimes, agentServer, fixedLlm } = dependencies
  const storedId = endpoint.conversationId
  const prompterId = prompt.authorId
  if (localSession && !signedIn.includes(localSession.signIn)) return { refusal: localSession.signInNotice }
  const storedConversation = storedId === null ? undefined : { ...endpoint, conversationId: storedId }
  let status = storedConversation && (await agentServer.statusOf(storedConversation))
  if (storedConversation && status === 'error' && endpoint.isHqAgent) {
    await agentServer.deleteConversation(storedConversation).catch(() => undefined)
    status = undefined
  }
  if (storedConversation && status !== undefined) {
    if (localSession) return keepAcpModel(dependencies, chat, storedConversation)
    return fixedLlm || !prompterId
      ? { conversation: storedConversation }
      : keepSession(dependencies, chat, storedConversation, prompterId)
  }
  if (storedId !== null) {
    await runtimes.forgetConversation(chat)
    if (!endpoint.isHqAgent)
      await transactor.run((unitOfWork) => appendNotice(unitOfWork, prompt, agentNotices.newSession))
  }
  if (localSession) {
    const { model } = await transactor.run(({ routing }) => routing.chatRouting(chat.chatId))
    return {
      conversation: await harnessConversationFor(dependencies, chat, endpoint, {
        launch: localSession.launch,
        model: '',
        acpModel: model ?? undefined,
      }),
    }
  }
  const routed = fixedLlm || !prompterId ? undefined : await routeSession(dependencies, chat, prompterId, prompt)
  const harness = routed?.harness
  if (routed && harness) {
    const { model, keysNotice } = harnesses[harness]
    if (!routed.canPrompt) return { refusal: keysNotice }
    const conversation = await harnessConversationFor(dependencies, chat, endpoint, {
      launch: harness,
      model: model.slice(model.indexOf('/') + 1),
    })
    await transactor.run(({ routing }) => routing.update(chat.chatId, { harness, model }))
    return { conversation }
  }
  if (routed && !routed.choice)
    return {
      refusal: noLlmKeyNoticeOf(await transactor.run(({ members }) => members.displayNameOf(prompterId as MemberId))),
    }
  const llm = routed?.choice
    ? agentLlmOf(routed.choice.model.id, routed.choice.effort)
    : { model: fixedLlm?.model ?? '', usageId: 'agent' }
  const llmToken = await runtimes.issueLlmToken(chat)
  const conversationId = await runtimes.rememberConversation(
    chat,
    await agentServer.createConversation(endpoint, llmToken, llm),
  )
  if (routed?.choice && prompterId) {
    const { model, effort, reason } = routed.choice
    await transactor.run(async ({ routing }) => {
      await routing.update(chat.chatId, { model: model.id, reasoningEffort: effort })
      await routing.setAgentModel(chat.chatId, model.id)
      await routing.record({
        chatId: chat.chatId,
        conversationId,
        role: 'session',
        memberId: prompterId,
        inputsDigest: routed.inputsDigest,
        classifierOutput: routed.answers ?? null,
        model: model.id,
        reason,
        costMicros: routed.costMicros,
      })
    })
  }
  return { conversation: { ...endpoint, conversationId } }
}

export const promptAgent = async (dependencies: AgentDependencies, { workspaceId, messageId }: Input) => {
  const { transactor, runtimes, agentServer, eventSockets } = dependencies
  const { chatId, type, localSession, harness } = await transactor.run(async ({ messages, chats }) => {
    const message = await messages.get(messageId)
    return { chatId: message.chatId, ...(await chats.get(message.chatId)) }
  })
  if (type !== 'runtime') return undefined
  const chat = { workspaceId, chatId }
  const readiness = await runtimes.ensureRunning(chat)
  if (readiness.state === 'starting') return { retryInMilliseconds: runtimeStartPollMilliseconds }
  if (readiness.state !== 'ready')
    return transactor.run((unitOfWork) =>
      noticeWaitingPrompts(unitOfWork, chatId, notReadyNoticeOf(readiness, localSession === true)),
    )
  const prompt = await transactor.run((unitOfWork) => beginAgentTurn(unitOfWork, chatId))
  if (!prompt) return undefined
  let conversation: AgentConversation
  try {
    const prepared = await conversationFor(
      dependencies,
      chat,
      readiness,
      prompt,
      localSession ? localSessions[harness ?? 'claude-code'] : undefined,
    )
    if ('refusal' in prepared)
      return transactor.run((unitOfWork) => closeAgentTurn(unitOfWork, chatId, prompt.id, () => prepared.refusal))
    conversation = prepared.conversation
    await eventSockets.ensureOpen(chat, conversation, prompt.id)
    await agentServer.sendMessage(conversation, prompt.body)
  } catch (error) {
    await transactor.run((unitOfWork) => releaseAgentTurn(unitOfWork, chatId, prompt.id))
    throw error
  }
  if ((await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))) === null)
    await agentServer.interrupt(conversation)
  await runtimes.touch(chat)
  return undefined
}
