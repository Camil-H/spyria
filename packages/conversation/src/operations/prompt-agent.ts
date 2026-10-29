import {
  type ChatId,
  can,
  chatModelsOf,
  cheapestModelOf,
  defaultDeployment,
  disclosableMessageOf,
  type HarnessId,
  harnessOf,
  isPickableModel,
  type MemberId,
  type MessageId,
  signInNoticeOf,
  type WorkspaceId,
  withPricesOf,
} from '@spyria/kernel'
import {
  type AgentChat,
  type AgentConversation,
  type AgentEndpoint,
  type AgentLlmChoice,
  AgentStartFailure,
  type RuntimeReadiness,
} from '../contracts/agent.ts'
import type { UnitOfWork } from '../contracts/transactor.ts'
import { agentNotices, hasOutlivedWait, notReadyNoticeOf } from '../domain/agent-events.ts'
import { noReplyAuthorOf } from '../domain/git-actions.ts'
import type { Message } from '../domain/message.ts'
import { noLlmKeyNoticeOf } from '../domain/model-call-failures.ts'
import { agentPromptTextOf, type QuotedMessage } from '../domain/seed-message.ts'
import {
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

type Input = { workspaceId: WorkspaceId; messageId: MessageId; isLastAttempt: boolean; isRetry: boolean }
type Prepared = { conversation: AgentConversation } | { refusal: string }
type NotReady = Exclude<RuntimeReadiness, { state: 'ready' | 'starting' }>

const runtimeStartPollMilliseconds = 500

const quotedByPrompt = async ({ messages, members }: UnitOfWork, prompt: Message) => {
  const quoted = prompt.quotedMessageId ? await messages.find(prompt.quotedMessageId) : undefined
  if (!quoted) return undefined
  const authorName = quoted.authorId ? await members.displayNameOf(quoted.authorId) : 'Agent'
  return { ...quoted, authorName } satisfies QuotedMessage
}

const reachableChatModelsOf = async (
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

type EarlyRoute = { promptId: MessageId; routed: Awaited<ReturnType<typeof routeSession>> }
const earlyRoutes = new Map<string, Promise<EarlyRoute | undefined>>()
const earlyRouteKeyOf = ({ workspaceId, chatId }: AgentChat) => `${workspaceId}:${chatId}`

const firstPromptRouteOf = async (dependencies: AgentDependencies, chat: AgentChat) => {
  const prompt = await dependencies.transactor.run(async ({ chats, agentTurns }) => {
    const next = (await chats.hasAgentSession(chat.chatId)) ? undefined : await agentTurns.nextPrompt(chat.chatId)
    const isRunnable =
      next?.authorId &&
      !hasOutlivedWait(next, Date.now()) &&
      can(await chats.permissions(chat.chatId, next.authorId), 'chat.post')
    return isRunnable ? next : undefined
  })
  if (!prompt?.authorId) return undefined
  return { promptId: prompt.id, routed: await routeSession(dependencies, chat, prompt.authorId, prompt) }
}

const routeWhileStarting = (dependencies: AgentDependencies, chat: AgentChat) => {
  if (dependencies.fixedLlm || earlyRoutes.has(earlyRouteKeyOf(chat))) return
  earlyRoutes.set(
    earlyRouteKeyOf(chat),
    firstPromptRouteOf(dependencies, chat).catch(() => undefined),
  )
}

const takeEarlyRoute = (chat: AgentChat) => {
  const early = earlyRoutes.get(earlyRouteKeyOf(chat))
  earlyRoutes.delete(earlyRouteKeyOf(chat))
  return early
}

const routedFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  earlyRoute: Promise<EarlyRoute | undefined> | undefined,
  prompterId: MemberId,
  prompt: Message,
) => {
  const early = await earlyRoute
  return early?.promptId === prompt.id ? early.routed : routeSession(dependencies, chat, prompterId, prompt)
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
  const { model, reasoningEffort, agentModel, agentReasoningEffort } = routing
  if (!model) return { conversation }
  if (!isPickableModel(model, reachable, classifier?.listedModels() ?? []))
    return { refusal: unreachableSessionNoticeOf(model) }
  if (agentModel === model && agentReasoningEffort === reasoningEffort) return { conversation }
  const isSwitched =
    chatModelsOf(reachable).some((candidate) => candidate.id === model) &&
    (await agentClient.switchModel(conversation, piModelOf(model), thoughtLevelOf(reasoningEffort)).then(
      () => true,
      () => false,
    ))
  const kept = isSwitched
    ? conversation
    : await relaunchedConversationOf(
        dependencies,
        chat,
        conversation,
        await piLlmOf(dependencies, prompterId, model, reasoningEffort),
      )
  await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model, reasoningEffort))
  return { conversation: kept }
}

const keepAdapterModel = async (
  { transactor, agentClient }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
): Promise<Prepared> => {
  const { model, reasoningEffort, agentModel, agentReasoningEffort } = await transactor.run(({ routing }) =>
    routing.chatRouting(chat.chatId),
  )
  const isModelChanged = Boolean(model) && model !== agentModel
  if (isModelChanged || (reasoningEffort && reasoningEffort !== agentReasoningEffort)) {
    await agentClient.switchModel(
      conversation,
      isModelChanged ? (model ?? undefined) : undefined,
      reasoningEffort ?? undefined,
    )
    await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model, reasoningEffort))
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

const checkoutWithOwnerOf = async ({ transactor, checkouts }: AgentDependencies, chat: AgentChat) => {
  const checkout = await checkouts?.checkoutOf(chat)
  if (!checkouts || !checkout) return checkout
  const owner = await transactor.run(async ({ chats, members }) => {
    const { ownerId } = await chats.get(chat.chatId)
    return ownerId && { ownerId, ownerName: await members.displayNameOf(ownerId) }
  })
  if (!owner) return checkout
  const githubAuthor = await checkouts.authorOf(chat, owner.ownerId).catch(() => undefined)
  const author = githubAuthor ?? noReplyAuthorOf(owner.ownerName, owner.ownerId)
  return { ...checkout, author }
}

const createdConversationOf = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  llm: AgentLlmChoice,
): Promise<AgentConversation> => {
  const { runtimes, agentClient } = dependencies
  const newId = crypto.randomUUID()
  const conversation = { ...endpoint, conversationId: await runtimes.rememberConversation(chat, newId) }
  if (conversation.conversationId === newId) {
    const checkout = await checkoutWithOwnerOf(dependencies, chat).catch((error: Error) => {
      throw new AgentStartFailure(disclosableMessageOf(error))
    })
    await agentClient.createConversation(conversation, await runtimes.issueLlmToken(chat), llm, undefined, checkout)
  }
  return conversation
}

const machineConversationFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  harness: HarnessId,
) => {
  const { transactor } = dependencies
  const { model, reasoningEffort } = await transactor.run(({ routing }) => routing.chatRouting(chat.chatId))
  const resumeSessionId = await transactor.run(({ agentEvents }) => agentEvents.lastSessionId(chat.chatId))
  const conversation = await createdConversationOf(dependencies, chat, endpoint, {
    harness,
    resumeSessionId,
    adapterModel: model ?? undefined,
    effort: reasoningEffort ?? undefined,
  })
  await transactor.run(({ routing }) => routing.setAgentModel(chat.chatId, model, reasoningEffort))
  return conversation
}

const conversationFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  { endpoint, signedIn }: Extract<RuntimeReadiness, { state: 'ready' }>,
  prompt: Message,
  harness: HarnessId | undefined,
): Promise<Prepared> => {
  const { transactor, fixedLlm, deployment = defaultDeployment } = dependencies
  const earlyRoute = takeEarlyRoute(chat)
  const prompterId = prompt.authorId
  if (harness && !signedIn.includes(harness)) return { refusal: signInNoticeOf(harness, deployment) }
  const storedConversation = await storedConversationOf(dependencies, chat, endpoint)
  if (storedConversation) {
    if (harness) return keepAdapterModel(dependencies, chat, storedConversation)
    return fixedLlm || !prompterId
      ? { conversation: storedConversation }
      : keepSession(dependencies, chat, storedConversation, prompterId)
  }
  if (harness) return { conversation: await machineConversationFor(dependencies, chat, endpoint, harness) }
  const routed =
    fixedLlm || !prompterId ? undefined : await routedFor(dependencies, chat, earlyRoute, prompterId, prompt)
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
      await routing.setAgentModel(chat.chatId, model.id, effort)
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
  if (!readiness.signedIn.includes(harnessOf(harness))) return undefined
  await eventSockets.ensureOpen(
    chat,
    (await storedConversationOf(dependencies, chat, readiness.endpoint)) ??
      (await machineConversationFor(dependencies, chat, readiness.endpoint, harnessOf(harness))),
    null,
  )
  return undefined
}

export const promptAgent = async (
  dependencies: AgentDependencies,
  { workspaceId, messageId, isLastAttempt, isRetry }: Input,
) => {
  const { transactor, runtimes, agentClient, eventSockets } = dependencies
  const { chatId, type, localSession, harness } = await transactor.run(async ({ messages, chats }) => {
    const message = await messages.get(messageId)
    return { chatId: message.chatId, ...(await chats.get(message.chatId)) }
  })
  if (type !== 'runtime') return undefined
  const chat = { workspaceId, chatId }
  const waitForRuntime = (readiness: NotReady, releasedPromptId?: MessageId) =>
    transactor.run(async (unitOfWork) => {
      if (releasedPromptId) await releaseAgentTurn(unitOfWork, chatId, releasedPromptId)
      await noticeWaitingPrompts(unitOfWork, chatId, notReadyNoticeOf(readiness, localSession === true))
    })
  if (localSession && (await transactor.run(({ chats }) => chats.isSessionStartPending(chatId))))
    return { retryInMilliseconds: runtimeStartPollMilliseconds }
  const readiness = await runtimes.ensureRunning(chat)
  if (readiness.state === 'starting') {
    if (!localSession) routeWhileStarting(dependencies, chat)
    return { retryInMilliseconds: runtimeStartPollMilliseconds }
  }
  if (readiness.state !== 'ready') {
    takeEarlyRoute(chat)
    return waitForRuntime(readiness, isRetry ? messageId : undefined)
  }
  const prompt = await transactor.run((unitOfWork) =>
    beginAgentTurn(unitOfWork, chatId, isRetry ? messageId : undefined),
  )
  if (!prompt) return undefined
  let conversation: AgentConversation
  try {
    const prepared = await conversationFor(
      dependencies,
      chat,
      readiness,
      prompt,
      localSession ? harnessOf(harness) : undefined,
    )
    if ('refusal' in prepared)
      return transactor.run((unitOfWork) => closeAgentTurn(unitOfWork, chatId, prompt.id, () => prepared.refusal))
    conversation = prepared.conversation
    await eventSockets.ensureOpen(chat, conversation, prompt.id)
    const { seed, quoted } = await transactor.run(async (unitOfWork) => ({
      seed: await unitOfWork.messages.seedFor(prompt),
      quoted: await quotedByPrompt(unitOfWork, prompt),
    }))
    await agentClient.sendMessage(conversation, agentPromptTextOf(prompt, seed, quoted), prompt.id)
  } catch (error) {
    if (await runtimes.isWaitingOnHost(chat)) return waitForRuntime({ state: 'host_offline' }, prompt.id)
    if (!(error instanceof AgentStartFailure) && !isLastAttempt) {
      if (prompt.id !== messageId) await transactor.run((unitOfWork) => releaseAgentTurn(unitOfWork, chatId, prompt.id))
      throw error
    }
    const notice = `${agentNotices.couldNotStart}: ${disclosableMessageOf(error)}`
    return transactor.run((unitOfWork) => closeAgentTurn(unitOfWork, chatId, prompt.id, () => notice))
  }
  if ((await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))) === null)
    await agentClient.interrupt(conversation)
  await runtimes.touch(chat)
  return undefined
}
