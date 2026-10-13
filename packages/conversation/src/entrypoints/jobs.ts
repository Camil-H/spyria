import { chatId, type MemberId, type MessageId, memberId, messageId, type WorkspaceId } from '@hq/kernel'
import { z } from 'zod/mini'
import type {
  AgentChat,
  AgentConversation,
  AgentEventListener,
  AgentEventSockets,
  AgentHost,
  SessionClassifier,
} from '../contracts/agent.ts'
import { type AgentEvent, isStoredAgentEvent, type TurnOutcome } from '../domain/agent-events.ts'
import { createRuntimeAgentRuntimes, type SandboxProvider } from '../integrations/runtime-agent-runtimes.ts'
import { type AgentLlm, createSandboxAgentServer } from '../integrations/sandbox-agent-server.ts'
import { agentJobTypes, createTransactingZeroTransactor, type Transact } from '../integrations/zero-transactor.ts'
import { closeReopenedTurn, reopenAgentTurn, sweepAgentTurns } from '../operations/agent-turn-safety.ts'
import { delegateTask } from '../operations/delegate.ts'
import {
  findCondenserModel,
  findModelCallTurn,
  findToolCallTurn,
  recordHarnessModel,
  recordModelCallFailure,
} from '../operations/model-calls.ts'
import { promptAgent, startAgentSession } from '../operations/prompt-agent.ts'
import { recordAgentEvent } from '../operations/record-agent-event.ts'
import { promptWaitingChats } from '../operations/retry-agent.ts'
import { interruptAgent } from '../operations/stop-agent.ts'

type Job = { workspaceId: WorkspaceId; payload: unknown }

const id = z.string().check(z.minLength(1))
const promptPayload = z.object({ messageId: z.pipe(id, z.transform(messageId)) })
const startSessionPayload = z.object({ chatId: z.pipe(id, z.transform(chatId)) })
const interruptPayload = z.object({
  chatId: z.pipe(id, z.transform(chatId)),
  promptId: z.pipe(id, z.transform(messageId)),
  memberId: z.pipe(id, z.transform(memberId)),
})

export const createAgentHandlers = ({
  transact,
  sandboxProvider,
  llm,
  classifier,
  eventSockets,
  now = Date.now,
  resumeAfterMilliseconds,
  condensationScale,
  hqAgentImage,
}: {
  transact: Transact
  sandboxProvider: SandboxProvider
  llm?: AgentLlm
  classifier?: SessionClassifier
  eventSockets: AgentEventSockets
  now?: () => number
  resumeAfterMilliseconds?: number
  condensationScale?: number
  hqAgentImage?: string
}) => {
  const runtimes = createRuntimeAgentRuntimes(transact, sandboxProvider, hqAgentImage)
  const agentServer = createSandboxAgentServer(condensationScale)
  const transactorOf = (id: WorkspaceId) => createTransactingZeroTransactor(transact, id)
  const dependenciesOf = (id: WorkspaceId) => ({
    transactor: transactorOf(id),
    runtimes,
    agentServer,
    eventSockets,
    classifier,
    fixedLlm: llm,
    resumeAfterMilliseconds,
  })
  return {
    jobs: {
      [agentJobTypes.prompt]: ({ workspaceId, payload }: Job) =>
        promptAgent(dependenciesOf(workspaceId), { workspaceId, messageId: promptPayload.parse(payload).messageId }),
      [agentJobTypes.startSession]: ({ workspaceId, payload }: Job) =>
        startAgentSession(dependenciesOf(workspaceId), { workspaceId, ...startSessionPayload.parse(payload) }),
      [agentJobTypes.interrupt]: ({ workspaceId, payload }: Job) =>
        interruptAgent(dependenciesOf(workspaceId), { workspaceId, ...interruptPayload.parse(payload) }),
      [agentJobTypes.sweep]: ({ workspaceId }: Job) =>
        sweepAgentTurns(dependenciesOf(workspaceId), { workspaceId, now: now() }),
    },
    openEvents: async (chat: AgentChat, conversation: AgentConversation, listener: AgentEventListener) =>
      agentServer.openEvents(
        conversation,
        (await transactorOf(chat.workspaceId).run(({ agentEvents }) => agentEvents.last(chat.chatId))) ?? null,
        listener,
      ),
    recordEvent: async (chat: AgentChat, event: AgentEvent, streamedText = '') => {
      if (!isStoredAgentEvent(event)) return undefined
      const recorded = await recordAgentEvent(
        { transactor: transactorOf(chat.workspaceId) },
        { ...chat, event, streamedText },
      )
      await runtimes.touch(chat)
      return recorded
    },
    reopenTarget: (chat: AgentChat) => reopenAgentTurn(dependenciesOf(chat.workspaceId), chat),
    closeReopenedTurn: (chat: AgentChat, promptId: MessageId, outcome: TurnOutcome) =>
      closeReopenedTurn(dependenciesOf(chat.workspaceId), { chat, promptId, outcome }),
    promptWaiting: (host: AgentHost) => promptWaitingChats(dependenciesOf(host.workspaceId), host),
    modelCallTurn: (host: AgentHost, token: string) => findModelCallTurn(dependenciesOf(host.workspaceId), host, token),
    condenserModel: (chat: AgentChat, prompterId: MemberId) =>
      findCondenserModel(dependenciesOf(chat.workspaceId), prompterId),
    toolCallTurn: (host: AgentHost, token: string) => findToolCallTurn(dependenciesOf(host.workspaceId), host, token),
    delegate: (input: Parameters<typeof delegateTask>[1]) =>
      delegateTask(dependenciesOf(input.chat.workspaceId), input),
    recordModelCallFailure: (call: Parameters<typeof recordModelCallFailure>[1]) =>
      recordModelCallFailure(dependenciesOf(call.chat.workspaceId), call),
    recordHarnessModel: (chat: AgentChat, model: string) =>
      recordHarnessModel(dependenciesOf(chat.workspaceId), chat, model),
  }
}
