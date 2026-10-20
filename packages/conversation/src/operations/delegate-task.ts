import { log, modelNameOf, withPricesOf } from '@spyria/kernel'
import type { AgentChat, AgentConversation } from '../contracts/agent.ts'
import type { ModelCallTurn } from '../contracts/repositories.ts'
import { executionStatusOf, isStoredAgentEvent, streamedTextOf, toolCallIdOf } from '../domain/agent-events.ts'
import type { StepDelegation } from '../domain/agent-steps.ts'
import {
  askedChoiceOf,
  defaultResumeAfterMilliseconds,
  delegationChoiceOf,
  delegationStateOf,
  effortHintOf,
  stillRunningOf,
  subagentFailureOf,
  subagentStopped,
  unknownTaskOf,
} from '../domain/delegation.ts'
import { sessionQuestions } from '../domain/session-routing.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { decide, digestOf, routingUnavailableOf } from './decide.ts'
import { fixedPiLlmOf, piLlmOf } from './prompt-agent.ts'
import { recordAgentEvent } from './record-agent-event.ts'
import { type DelegationResult, type RunningDelegation, runningDelegations } from './running-delegations.ts'

type Input = {
  chat: AgentChat
  turn: ModelCallTurn & { prompterName: string }
  task: string
  effort: unknown
  model?: unknown
}
const cannotStart = { text: 'The subagent could not start', isError: true }

export const noteSubagentFailure = (delegationId: string, notice: string) => {
  const running = runningDelegations.get(delegationId)
  if (running) running.failure = notice
  return notice
}

const chooseSubagent = async (dependencies: AgentDependencies, input: Input, effortHint: string) => {
  const { chat, turn, task } = input
  const { routing, reachable } = await dependencies.transactor.run(async ({ routing }) => ({
    routing: await routing.chatRouting(chat.chatId),
    reachable: (await routing.reachableModels(turn.prompterId)) ?? [],
  }))
  const sessionModel = routing.agentModel ?? routing.model
  const session = { model: sessionModel, effort: routing.reasoningEffort, policy: routing.subagentPolicy }
  const priced = withPricesOf(reachable, dependencies.classifier?.listedModels() ?? [])
  const asked = askedChoiceOf(priced, input.model, turn.prompterName)
  if (asked) return { ...session, ...asked, answers: undefined }
  if (routing.subagentPolicy === 'same_as_main') return { ...session, reason: 'same as main', answers: undefined }
  const decision = await decide(dependencies, {
    models: reachable,
    chat,
    prompterId: turn.prompterId,
    ownerId: turn.ownerId,
    state: delegationStateOf(task, effortHint, routing.mode),
    questions: sessionQuestions,
  })
  const classified = delegationChoiceOf(priced, decision?.answers)
  const reason = decision?.failure ? routingUnavailableOf(decision.failure) : 'default'
  return { ...session, reason, ...classified, answers: decision?.answers }
}

const runSubConversation = (
  { transactor, runtimes, agentClient, eventSockets }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
  task: string,
  delegation: StepDelegation,
  running: RunningDelegation,
) =>
  new Promise<{ status: string; answer: string }>((resolve, reject) => {
    let recording = Promise.resolve()
    let answer = ''
    let isStreaming = false
    const stream = (text: string, isReasoning?: boolean) =>
      eventSockets.streamDelegated(chat, {
        promptId: running.promptId,
        delegationId: delegation.id,
        text,
        ...(isReasoning && { isReasoning }),
      })
    const finish = (status: string) =>
      void recording.then(() => {
        socket.close()
        resolve({ status, answer })
      })
    const socket = agentClient.openEvents(conversation, null, {
      onEvent: (event) => {
        const streamed = streamedTextOf(event)
        if (streamed && !streamed.isReasoning) answer += streamed.text
        if (streamed?.text) {
          stream(streamed.text, streamed.isReasoning)
          isStreaming = true
        }
        if (toolCallIdOf(event) !== undefined) {
          answer = ''
          if (isStreaming) stream('')
          isStreaming = false
        }
        if (isStoredAgentEvent(event))
          recording = recording
            .then(() => recordAgentEvent({ transactor }, { ...chat, event, delegation }))
            .then(() => runtimes.touch(chat))
            .catch((error) =>
              log.error({
                event: 'delegation.event.record_failed',
                body: 'Recording a subagent event failed',
                attributes: { 'workspace.id': chat.workspaceId, 'chat.id': chat.chatId },
                error,
              }),
            )
        const status = executionStatusOf(event)
        if (status) finish(status)
      },
      onClose: () => void recording.then(() => resolve({ status: 'closed', answer })),
    })
    agentClient.sendMessage(conversation, task).catch(reject)
  })

const answerWithin = async (dependencies: AgentDependencies, id: string, running: RunningDelegation) => {
  const waited = Promise.withResolvers<undefined>()
  const timer = setTimeout(waited.resolve, dependencies.resumeAfterMilliseconds ?? defaultResumeAfterMilliseconds)
  const result = await Promise.race([running.result, waited.promise])
  clearTimeout(timer)
  if (!result) return { text: stillRunningOf(id), isError: false }
  runningDelegations.delete(id)
  return result
}

const runDelegation = async (
  dependencies: AgentDependencies,
  input: Input,
  endpoint: AgentConversation,
  choice: { effort: string | null },
  { token, delegation, running }: { token: string; delegation: StepDelegation; running: RunningDelegation },
): Promise<DelegationResult> => {
  const { transactor, agentClient } = dependencies
  let status: 'finished' | 'failed' = 'failed'
  try {
    const conversation = { ...endpoint, conversationId: crypto.randomUUID() }
    await agentClient.createConversation(
      conversation,
      token,
      dependencies.fixedLlm
        ? fixedPiLlmOf(delegation.model)
        : await piLlmOf(dependencies, input.turn.prompterId, delegation.model, choice.effort),
      { parentConversationId: endpoint.conversationId },
    )
    await transactor.run(({ delegations }) =>
      delegations.update(delegation.id, { conversationId: conversation.conversationId }),
    )
    const { status: endStatus, answer } = await runSubConversation(
      dependencies,
      input.chat,
      conversation,
      input.task,
      delegation,
      running,
    )
    if (endStatus === 'paused') return { text: subagentStopped, isError: true }
    if (endStatus !== 'finished' || running.failure)
      return { text: subagentFailureOf(delegation.modelName, running.failure), isError: true }
    status = 'finished'
    return { text: answer.trim(), isError: false }
  } catch {
    return cannotStart
  } finally {
    await transactor.run(({ delegations }) => delegations.update(delegation.id, { status }))
  }
}

export const awaitTask = async (
  dependencies: AgentDependencies,
  { chat, turn, taskId }: { chat: AgentChat; turn: ModelCallTurn; taskId: unknown },
): Promise<DelegationResult> => {
  const id = String(taskId ?? '')
  const running = runningDelegations.get(id)
  if (running?.chatId !== chat.chatId || running.promptId !== turn.promptId)
    return { text: unknownTaskOf(id), isError: true }
  return answerWithin(dependencies, id, running)
}

export const delegateTask = async (dependencies: AgentDependencies, input: Input): Promise<DelegationResult> => {
  const { transactor, runtimes, fixedLlm } = dependencies
  const { chat, turn, task } = input
  const effortHint = effortHintOf(input.effort)
  const choice = await chooseSubagent(dependencies, input, effortHint)
  const endpoint = await runtimes.endpointOf(chat)
  const model = choice.model ?? fixedLlm?.model.replace(/^openai\//, '')
  if (!model || !endpoint?.conversationId) return cannotStart
  const id = crypto.randomUUID()
  const token = `dl_${crypto.randomUUID().replaceAll('-', '')}`
  const fallback = 'fallback' in choice ? choice.fallback : undefined
  const delegation = { id, model, modelName: modelNameOf(model), task, ...(fallback && { fallback }) }
  const tokenHash = await digestOf(token)
  await transactor.run(({ delegations }) =>
    delegations.start({
      chatId: chat.chatId,
      id,
      promptId: turn.promptId,
      task,
      effortHint,
      policy: choice.policy,
      classifierOutput: choice.answers ?? null,
      model,
      reason: choice.reason,
      tokenHash,
    }),
  )
  const running: RunningDelegation = {
    chatId: chat.chatId,
    promptId: turn.promptId,
    result: Promise.resolve(cannotStart),
  }
  runningDelegations.set(id, running)
  running.result = runDelegation(
    dependencies,
    input,
    { ...endpoint, conversationId: endpoint.conversationId },
    choice,
    { token, delegation, running },
  )
  return answerWithin(dependencies, id, running)
}
