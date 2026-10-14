import {
  type ChatId,
  chatModelsOf,
  cheapestModelOf,
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
  type HarnessLaunch,
  harnesses,
  harnessOfKeys,
  type LocalSession,
  localSessions,
  piModelOf,
  reachesHarness,
  sessionChoiceOf,
  sessionQuestions,
  sessionStateOf,
  thoughtLevelOf,
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
  return {
    model,
    usageId: 'agent',
    acpModel: piModelOf(model),
    effort: thoughtLevelOf(effort),
    pi: {
      models: models.map(({ id, name, contextWindow }) => ({ id, name, contextWindow, reasoning: true })),
      compactionModel: cheapestModelOf(models)?.id ?? model,
    },
  }
}

export const fixedPiLlmOf = (fixedModel: string): AgentLlmChoice => {
  const model = fixedModel.replace(/^openai\//, '')
  const pi = { models: [{ id: model, name: model, reasoning: true }], compactionModel: model }
  return { model, usageId: 'agent', acpModel: piModelOf(model), pi }
}

const routeSession = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  prompterId: MemberId,
  prompt: Message,
  isPi: boolean,
) => {
  const { routing, reachable } = await dependencies.transactor.run(async ({ routing }) => ({
    routing: await routing.chatRouting(chat.chatId),
    reachable: (await routing.reachableModels(prompterId)) ?? [],
  }))
  const harness = isPi ? undefined : (routing.harness ?? harnessOfKeys(reachable))
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
  if (harness && !conversation.isHqAgent)
    return reachesHarness(harness, reachable ?? []) ? { conversation } : { refusal: harnesses[harness].keysNotice }
  if (!model) return { conversation }
  if (!chatModelsOf(reachable ?? []).some((candidate) => candidate.id === model))
    return { refusal: unreachableSessionNoticeOf(model) }
  if (agentModel !== model) {
    if (conversation.isHqAgent)
      await agentServer.switchAcpModel(conversation, piModelOf(model), thoughtLevelOf(reasoningEffort))
    else
      await agentServer.switchLlm(
        conversation,
        await runtimes.issueLlmToken(chat, true),
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

const machineConversationFor = async (
  dependencies: AgentDependencies,
  chat: AgentChat,
  endpoint: AgentEndpoint,
  localSession: LocalSession,
) => {
  const { model } = await dependencies.transactor.run(({ routing }) => routing.chatRouting(chat.chatId))
  return harnessConversationFor(dependencies, chat, endpoint, {
    launch: localSession.launch,
    model: '',
    acpModel: model ?? undefined,
  })
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
  if (localSession) return { conversation: await machineConversationFor(dependencies, chat, endpoint, localSession) }
  const isPi = endpoint.isHqAgent
  const routed = fixedLlm || !prompterId ? undefined : await routeSession(dependencies, chat, prompterId, prompt, isPi)
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
  const llm =
    routed?.choice && prompterId && isPi
      ? {
          ...(await piLlmOf(dependencies, prompterId, routed.choice.model.id, routed.choice.effort)),
          resumeSessionId: await transactor.run(({ agentEvents }) => agentEvents.lastSessionId(chat.chatId)),
        }
      : routed?.choice
        ? agentLlmOf(routed.choice.model.id, routed.choice.effort)
        : fixedLlm && isPi
          ? fixedPiLlmOf(fixedLlm.model)
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
  if (readiness.state !== 'ready' || readiness.endpoint.conversationId !== null) return undefined
  const session = localSessions[harness ?? 'claude-code']
  if (!readiness.signedIn.includes(session.signIn)) return undefined
  await eventSockets.ensureOpen(
    chat,
    await machineConversationFor(dependencies, chat, readiness.endpoint, session),
    null,
  )
  return undefined
}

export const promptAgent = async (dependencies: AgentDependencies, { workspaceId, messageId }: Input) => {
  const { transactor, runtimes, agentServer, eventSockets } = dependencies
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
    await agentServer.sendMessage(conversation, prompt.body)
  } catch (error) {
    if (error instanceof AgentStartFailure)
      return transactor.run((unitOfWork) =>
        closeAgentTurn(unitOfWork, chatId, prompt.id, () => `${agentNotices.couldNotStart}: ${error.message}`),
      )
    await transactor.run((unitOfWork) => releaseAgentTurn(unitOfWork, chatId, prompt.id))
    throw error
  }
  if ((await transactor.run(({ agentTurns }) => agentTurns.lock(chatId))) === null)
    await agentServer.interrupt(conversation)
  await runtimes.touch(chat)
  return undefined
}
