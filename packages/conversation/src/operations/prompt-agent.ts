import {
  type ChatId,
  chatModelsOf,
  cheapestModelOf,
  isPickableModel,
  type MemberId,
  type MessageId,
  type WorkspaceId,
  withPricesOf,
} from '@hq/kernel'
import {
  type AgentChat,
  type AgentConversation,
  type AgentEndpoint,
  type AgentLlmChoice,
  AgentStartFailure,
  type RuntimeReadiness,
} from '../contracts/agent.ts'
import { agentNotices, notReadyNoticeOf } from '../domain/agent-events.ts'
import type { Message } from '../domain/message.ts'
import { noLlmKeyNoticeOf } from '../domain/model-call-failures.ts'
import {
  type LocalSession,
  localSessions,
  piModelOf,
  sessionChoiceOf,
  sessionQuestions,
  sessionStateOf,
  thoughtLevelOf,
  unreachableSessionNoticeOf,
} from '../domain/session-routing.ts'
import {
  type AgentDependencies,
  beginAgentTurn,
  closeAgentTurn,
  noticeWaitingPrompts,
  releaseAgentTurn,
} from './agent-turn.ts'
import { decide, routingUnavailableOf } from './decide.ts'

type Input = { workspaceId: WorkspaceId; messageId: MessageId; isLastAttempt: boolean }
type Prepared = { conversation: AgentConversation } | { refusal: string }

const runtimeStartPollMilliseconds = 500

export const reachableChatModelsOf = async (
  { transactor, classifier }: Pick<AgentDependencies, 'transactor' | 'classifier'>,
  prompterId: MemberId,
) =>
  chatModelsOf(
    withPricesOf(
      (await transactor.run(({ routing }) => routing.reachableModels(prompterId))) ?? [],
      classifier?.listedModels() ?? [],
    ),
  )

export const piLlmOf = async (
  dependencies: Pick<AgentDependencies, 'transactor' | 'classifier'>,
  prompterId: MemberId,
  model: string,
  effort: string | null,
): Promise<AgentLlmChoice> => {
  const models = await reachableChatModelsOf(dependencies, prompterId)
  const listing = dependencies.classifier?.listedModels() ?? []
  const launched = models.some(({ id }) => id === model)
    ? models
    : [...models, { name: model, ...listing.find(({ id }) => id === model), id: model }]
  return {
    adapterModel: piModelOf(model),
    effort: thoughtLevelOf(effort),
    pi: {
      models: launched.map(({ id, name, contextWindow }) => ({ id, name, contextWindow, reasoning: true })),
      compactionModel: cheapestModelOf(models)?.id ?? model,
    },
  }
}

export const fixedPiLlmOf = (fixedModel: string): AgentLlmChoice => {
  const model = fixedModel.replace(/^openai\//, '')
  const pi = { models: [{ id: model, name: model, reasoning: true }], compactionModel: model }
  return { adapterModel: piModelOf(model), pi }
}

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
  const decision = await decide(dependencies, {
    models: reachable,
    chat,
    prompterId,
    ownerId: routing.ownerId,
    state: sessionStateOf(prompt.body, routing.mode),
    questions: sessionQuestions,
  })
  const choice = sessionChoiceOf({ reachable, answers: decision?.answers })
  return {
    choice: choice && {
      ...choice,
      reason: decision && !decision.failure ? choice.reason : routingUnavailableOf(decision?.failure),
    },
    answers: decision?.answers,
    costMicros: decision?.costMicros ?? 0,
    inputsDigest: decision?.inputsDigest ?? null,
  }
}

const relaunchedConversationOf = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
  llm: AgentLlmChoice,
) => {
  const { agentClient, runtimes, transactor } = dependencies
  await agentClient.deleteConversation(conversation).catch(() => undefined)
  await runtimes.forgetConversation(chat)
  const resumeSessionId = await transactor.run(({ agentEvents }) => agentEvents.lastSessionId(chat.chatId))
  return createdConversationOf(dependencies, chat, conversation, { ...llm, resumeSessionId })
}

const keepSession = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
  prompterId: MemberId,
): Promise<Prepared> => {
  const { transactor, agentClient, classifier } = dependencies
  const { routing, reachable } = await transactor.run(async ({ routing }) => ({
    routing: await routing.chatRouting(chat.chatId),
    reachable: (await routing.reachableModels(prompterId)) ?? [],
  }))
  const { model, reasoningEffort, agentModel } = routing
  if (!model) return { conversation }
  if (!isPickableModel(model, reachable, classifier?.listedModels() ?? []))
    return { refusal: unreachableSessionNoticeOf(model) }
  if (agentModel === model) return { conversation }
  const isLaunched = chatModelsOf(reachable).some((candidate) => candidate.id === model)
  if (isLaunched) await agentClient.switchModel(conversation, piModelOf(model), thoughtLevelOf(reasoningEffort))
  const kept = isLaunched
    ? conversation
    : await relaunchedConversationOf(
        dependencies,
        chat,
        conversation,
        await piLlmOf(dependencies, prompterId, model, reasoningEffort),
      )
  await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model))
  return { conversation: kept }
}

const keepAdapterModel = async (
  { transactor, agentClient }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
): Promise<Prepared> => {
  const { model, agentModel } = await transactor.run(({ routing }) => routing.chatRouting(chat.chatId))
  if (model && model !== agentModel) {
    await agentClient.switchModel(conversation, model)
    await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model))
  }
  return { conversation }
}

const storedConversationOf = async (
  { runtimes, agentClient }: AgentDependencies,
  chat: AgentChat,
  { conversationId, ...endpoint }: AgentEndpoint,
) => {
  if (conversationId === null) return undefined
  const stored = { ...endpoint, conversationId }
  const status = await agentClient.statusOf(stored)
  if (status !== undefined && status !== 'error') return stored
  if (status === 'error') await agentClient.deleteConversation(stored).catch(() => undefined)
  await runtimes.forgetConversation(chat)
  return undefined
}

const createdConversationOf = async (
  { runtimes, agentClient }: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  llm: AgentLlmChoice,
): Promise<AgentConversation> => {
  const newId = crypto.randomUUID()
  const conversation = { ...endpoint, conversationId: await runtimes.rememberConversation(chat, newId) }
  if (conversation.conversationId === newId)
    await agentClient.createConversation(conversation, await runtimes.issueLlmToken(chat), llm)
  return conversation
}

const machineConversationFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  localSession: LocalSession,
) => {
  const { transactor } = dependencies
  const { model } = await transactor.run(({ routing }) => routing.chatRouting(chat.chatId))
  const resumeSessionId = await transactor.run(({ agentEvents }) => agentEvents.lastSessionId(chat.chatId))
  const conversation = await createdConversationOf(dependencies, chat, endpoint, {
    harness: localSession.launch,
    resumeSessionId,
    adapterModel: model ?? undefined,
  })
  if (model) await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model))
  return conversation
}

const conversationFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  { endpoint, signedIn }: Extract<RuntimeReadiness, { state: 'ready' }>,
  prompt: Message,
  localSession: LocalSession | undefined,
): Promise<Prepared> => {
  const { transactor, fixedLlm } = dependencies
  const prompterId = prompt.authorId
  if (localSession && !signedIn.includes(localSession.signIn)) return { refusal: localSession.signInNotice }
  const storedConversation = await storedConversationOf(dependencies, chat, endpoint)
  if (storedConversation) {
    if (localSession) return keepAdapterModel(dependencies, chat, storedConversation)
    return fixedLlm || !prompterId
      ? { conversation: storedConversation }
      : keepSession(dependencies, chat, storedConversation, prompterId)
  }
  if (localSession) return { conversation: await machineConversationFor(dependencies, chat, endpoint, localSession) }
  const routed = fixedLlm || !prompterId ? undefined : await routeSession(dependencies, chat, prompterId, prompt)
  const llm: AgentLlmChoice | undefined =
    routed?.choice && prompterId
      ? {
          ...(await piLlmOf(dependencies, prompterId, routed.choice.model.id, routed.choice.effort)),
          resumeSessionId: await transactor.run(({ agentEvents }) => agentEvents.lastSessionId(chat.chatId)),
        }
      : fixedLlm && fixedPiLlmOf(fixedLlm.model)
  if (!llm)
    return {
      refusal: noLlmKeyNoticeOf(await transactor.run(({ members }) => members.displayNameOf(prompterId as MemberId))),
    }
  const conversation = await createdConversationOf(dependencies, chat, endpoint, llm)
  if (routed?.choice && prompterId) {
    const { model, effort, reason } = routed.choice
    await transactor.run(async ({ routing }) => {
      await routing.update(chat.chatId, { model: model.id, reasoningEffort: effort })
      await routing.setAgentModel(chat.chatId, model.id)
      await routing.record({
        chatId: chat.chatId,
        conversationId: conversation.conversationId,
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
  return { conversation }
}

export const startAgentSession = async (
  dependencies: AgentDependencies,
  { workspaceId, chatId }: { workspaceId: WorkspaceId; chatId: ChatId },
) => {
  const { transactor, runtimes, eventSockets } = dependencies
  const { type, localSession, harness } = await transactor.run(({ chats }) => chats.get(chatId))
  if (type !== 'runtime' || !localSession) return undefined
  const chat = { workspaceId, chatId }
  const readiness = await runtimes.ensureRunning(chat)
  if (readiness.state === 'starting') return { retryInMilliseconds: runtimeStartPollMilliseconds }
  if (readiness.state !== 'ready') return undefined
  const session = localSessions[harness ?? 'claude-code']
  if (!readiness.signedIn.includes(session.signIn)) return undefined
  await eventSockets.ensureOpen(
    chat,
    (await storedConversationOf(dependencies, chat, readiness.endpoint)) ??
      (await machineConversationFor(dependencies, chat, readiness.endpoint, session)),
    null,
  )
  return undefined
}

export const promptAgent = async (
  dependencies: AgentDependencies,
  { workspaceId, messageId, isLastAttempt }: Input,
) => {
  const { transactor, runtimes, agentClient, eventSockets } = dependencies
  const { chatId, type, localSession, harness } = await transactor.run(async ({ messages, chats }) => {
    const message = await messages.get(messageId)
    return { chatId: message.chatId, ...(await chats.get(message.chatId)) }
  })
  if (type !== 'runtime') return undefined
  const chat = { workspaceId, chatId }
  if (localSession && (await transactor.run(({ chats }) => chats.isSessionStartPending(chatId))))
    return { retryInMilliseconds: runtimeStartPollMilliseconds }
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
    await agentClient.sendMessage(conversation, prompt.body)
  } catch (error) {
    if (!(error instanceof AgentStartFailure) && !isLastAttempt) {
      await transactor.run((unitOfWork) => releaseAgentTurn(unitOfWork, chatId, prompt.id))
      throw error
    }
    const notice =
      error instanceof AgentStartFailure || !(await runtimes.isWaitingOnHost(chat))
        ? `${agentNotices.couldNotStart}: ${error instanceof Error ? error.message : 'unknown error'}`
        : notReadyNoticeOf({ state: 'host_offline' }, localSession === true)
    return transactor.run((unitOfWork) => closeAgentTurn(unitOfWork, chatId, prompt.id, () => notice))
  }
  if ((await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))) === null)
    await agentClient.interrupt(conversation)
  await runtimes.touch(chat)
  return undefined
}
