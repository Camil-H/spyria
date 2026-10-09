import { modelNameOf, withPricesOf } from '@hq/kernel'
import type { AgentChat, AgentConversation } from '../contracts/agent.ts'
import type { ModelCallTurn } from '../contracts/repositories.ts'
import { type EventDelegation, executionStatusOf, isStoredAgentEvent } from '../domain/agent-events.ts'
import { delegationChoiceOf, delegationStateOf, effortHintOf, subagentFailureOf } from '../domain/delegation.ts'
import { sessionQuestions } from '../domain/session-routing.ts'
import type { AgentDependencies } from './agent-turn.ts'
import { decide, digestOf } from './decide.ts'
import { agentLlmOf } from './prompt-agent.ts'
import { recordAgentEvent } from './record-agent-event.ts'

type Input = { chat: AgentChat; turn: ModelCallTurn; toolToken: string; task: string; effort: unknown }
export type DelegationResult = { text: string; isError: boolean }

const actionWaitMilliseconds = 2000
const actionPollMilliseconds = 50
const endStatuses = ['finished', 'error', 'stuck', 'paused', 'closed']
const cannotStart = { text: 'The subagent could not start', isError: true }

const chooseSubagent = async (dependencies: AgentDependencies, { chat, turn, task }: Input, effortHint: string) => {
  const { routing, reachable } = await dependencies.transactor.run(async ({ routing }) => ({
    routing: await routing.chatRouting(chat.chatId),
    reachable: (await routing.reachableModels(turn.prompterId)) ?? [],
  }))
  const sessionModel = routing.agentModel ?? routing.model
  const session = { model: sessionModel, effort: routing.reasoningEffort, policy: routing.subagentPolicy }
  if (routing.subagentPolicy === 'same_as_main') return { ...session, reason: 'same as main', answers: undefined }
  const decision = await decide(dependencies, {
    models: reachable,
    chat,
    prompterId: turn.prompterId,
    ownerId: turn.ownerId,
    state: delegationStateOf(task, effortHint, routing.mode),
    questions: sessionQuestions,
  })
  const classified = delegationChoiceOf(
    withPricesOf(reachable, dependencies.classifier?.listedModels() ?? []),
    decision?.answers,
  )
  return { ...session, reason: 'default', ...classified, answers: decision?.answers }
}

const awaitDelegateAction = async ({ transactor }: AgentDependencies, chat: AgentChat) => {
  for (const deadline = Date.now() + actionWaitMilliseconds; ; ) {
    const actionId = await transactor.run(({ delegations }) => delegations.unansweredAction(chat.chatId))
    if (actionId || Date.now() > deadline) return actionId ?? null
    await new Promise((resolve) => setTimeout(resolve, actionPollMilliseconds))
  }
}

const runSubConversation = (
  { transactor, runtimes, agentServer }: AgentDependencies,
  chat: AgentChat,
  conversation: AgentConversation,
  task: string,
  delegation: EventDelegation,
) =>
  new Promise<string>((resolve, reject) => {
    let recording = Promise.resolve()
    const socket = agentServer.openEvents(conversation, null, {
      onEvent: (event) => {
        if (isStoredAgentEvent(event))
          recording = recording
            .then(() => recordAgentEvent({ transactor }, { ...chat, event, delegation }))
            .then(() => runtimes.touch(chat))
            .catch((error) => console.error(`Recording a subagent event of chat ${chat.chatId} failed: ${error}`))
        const status = executionStatusOf(event)
        if (status && endStatuses.includes(status))
          void recording.then(() => {
            socket.close()
            resolve(status)
          })
      },
      onClose: () => void recording.then(() => resolve('closed')),
    })
    agentServer.sendMessage(conversation, task).catch(reject)
  })

export const delegateTask = async (dependencies: AgentDependencies, input: Input): Promise<DelegationResult> => {
  const { transactor, runtimes, agentServer, fixedLlm } = dependencies
  const { chat, turn, task } = input
  const effortHint = effortHintOf(input.effort)
  const choice = await chooseSubagent(dependencies, input, effortHint)
  const endpoint = await runtimes.endpointOf(chat)
  const model = choice.model ?? fixedLlm?.model.replace(/^openai\//, '')
  if (!model || !endpoint?.conversationId) return cannotStart
  const id = crypto.randomUUID()
  const token = `dl_${crypto.randomUUID().replaceAll('-', '')}`
  const delegation = {
    id,
    model,
    modelName: modelNameOf(model),
    actionId: await awaitDelegateAction(dependencies, chat),
  }
  const tokenHash = await digestOf(token)
  await transactor.run(({ delegations }) =>
    delegations.start({
      chatId: chat.chatId,
      id,
      promptId: turn.promptId,
      actionEventId: delegation.actionId,
      task,
      effortHint,
      policy: choice.policy,
      classifierOutput: choice.answers ?? null,
      model,
      reason: choice.reason,
      tokenHash,
    }),
  )
  let status: 'finished' | 'failed' = 'failed'
  try {
    const subConversationId = await agentServer.createConversation(endpoint, token, agentLlmOf(model, choice.effort), {
      parentConversationId: endpoint.conversationId,
      toolToken: input.toolToken,
    })
    await transactor.run(({ delegations }) => delegations.update(id, { conversationId: subConversationId }))
    const conversation = { ...endpoint, conversationId: subConversationId }
    if ((await runSubConversation(dependencies, chat, conversation, task, delegation)) !== 'finished')
      return { text: subagentFailureOf(delegation.modelName), isError: true }
    const text = await agentServer.finalResponse(conversation)
    status = 'finished'
    return { text, isError: false }
  } catch {
    return cannotStart
  } finally {
    await transactor.run(({ delegations }) => delegations.update(id, { status }))
  }
}
