import { type ChatId, type MessageId, modelNameOf, withPricesOf } from '@hq/kernel'
import type { AgentChat, AgentConversation } from '../contracts/agent.ts'
import type { ModelCallTurn } from '../contracts/repositories.ts'
import { executionStatusOf, isStoredAgentEvent } from '../domain/agent-events.ts'
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
import { decide, digestOf } from './decide.ts'
import { agentLlmOf } from './prompt-agent.ts'
import { recordAgentEvent } from './record-agent-event.ts'

type Input = {
  chat: AgentChat
  turn: ModelCallTurn & { prompterName: string }
  toolToken: string
  task: string
  effort: unknown
  model?: unknown
  resume?: unknown
}
export type DelegationResult = { text: string; isError: boolean }
type RunningDelegation = { chatId: ChatId; promptId: MessageId; result: Promise<DelegationResult>; failure?: string }

const endStatuses = ['finished', 'stuck', 'paused', 'closed']
const cannotStart = { text: 'The subagent could not start', isError: true }
const runningDelegations = new Map<string, RunningDelegation>()

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
  return { ...session, reason: 'default', ...classified, answers: decision?.answers }
}

const runSubConversation = (
  { transactor, runtimes, agentServer }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
  task: string,
  delegation: StepDelegation,
  running: RunningDelegation,
) =>
  new Promise<string>((resolve, reject) => {
    let recording = Promise.resolve()
    const finish = (status: string) =>
      void recording.then(() => {
        socket.close()
        resolve(status)
      })
    const socket = agentServer.openEvents(conversation, null, {
      onEvent: (event) => {
        if (isStoredAgentEvent(event))
          recording = recording
            .then(() =>
              recordAgentEvent(
                { transactor },
                {
                  ...chat,
                  event,
                  delegation,
                  subagentFailure: running.failure ?? subagentFailureOf(delegation.modelName),
                },
              ),
            )
            .then(() => runtimes.touch(chat))
            .catch((error) => console.error(`Recording a subagent event of chat ${chat.chatId} failed: ${error}`))
        const status = executionStatusOf(event)
        if (event.kind === 'ConversationErrorEvent') finish('error')
        else if (status && endStatuses.includes(status)) finish(status)
      },
      onClose: () => void recording.then(() => resolve('closed')),
    })
    agentServer.sendMessage(conversation, task).catch(reject)
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
  const { transactor, agentServer } = dependencies
  let status: 'finished' | 'failed' = 'failed'
  try {
    const subConversationId = await agentServer.createConversation(
      endpoint,
      token,
      agentLlmOf(delegation.model, choice.effort),
      { parentConversationId: endpoint.conversationId, toolToken: input.toolToken },
    )
    await transactor.run(({ delegations }) => delegations.update(delegation.id, { conversationId: subConversationId }))
    const conversation = { ...endpoint, conversationId: subConversationId }
    const endStatus = await runSubConversation(dependencies, input.chat, conversation, input.task, delegation, running)
    if (endStatus === 'paused') return { text: subagentStopped, isError: true }
    if (endStatus !== 'finished')
      return { text: subagentFailureOf(delegation.modelName, running.failure), isError: true }
    const text = await agentServer.finalResponse(conversation)
    status = 'finished'
    return { text, isError: false }
  } catch {
    return cannotStart
  } finally {
    await transactor.run(({ delegations }) => delegations.update(delegation.id, { status }))
  }
}

export const delegateTask = async (dependencies: AgentDependencies, input: Input): Promise<DelegationResult> => {
  const { transactor, runtimes, fixedLlm } = dependencies
  const { chat, turn, task } = input
  if (input.resume) {
    const id = String(input.resume)
    const running = runningDelegations.get(id)
    if (running?.chatId !== chat.chatId || running.promptId !== turn.promptId)
      return { text: unknownTaskOf(id), isError: true }
    return answerWithin(dependencies, id, running)
  }
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
