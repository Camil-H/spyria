import type { Job, Transact } from '@hq/db/zero-queries'
import { chatId, type MemberId, type MessageId, memberId, messageId, type WorkspaceId } from '@hq/kernel'
import { z } from 'zod/mini'
import type {
  AgentChat,
  AgentConversation,
  AgentEventListener,
  AgentEventSockets,
  AgentHost,
  RepositoryCheckouts,
  SessionClassifier,
} from '../contracts/agent.ts'
import { type AgentEvent, agentJobTypes, isStoredAgentEvent, type TurnOutcome } from '../domain/agent-events.ts'
import { type AgentLlm, createHqAgentClient } from '../integrations/hq-agent-client.ts'
import { createRuntimeAgentRuntimes, type SandboxProvider } from '../integrations/runtime-agent-runtimes.ts'
import { workspaceJobTypes } from '../integrations/workspace-jobs.ts'
import { createTransactingZeroTransactor } from '../integrations/zero-transactor.ts'
import { closeReopenedTurn, reopenAgentTurn, sweepAgentTurns } from '../operations/agent-turn-safety.ts'
import { authorizeToolCall } from '../operations/authorize-tool-call.ts'
import { awaitTask, delegateTask } from '../operations/delegate-task.ts'
import { forwardToAgent } from '../operations/forward-to-agent.ts'
import { interruptOwnedTurns } from '../operations/interrupt-owned-turns.ts'
import {
  findModelCallTurn,
  findToolCallTurn,
  recordModelCallFailure,
  recordToolCall,
} from '../operations/model-calls.ts'
import { promptAgent, startAgentSession } from '../operations/prompt-agent.ts'
import { recordAgentEvent } from '../operations/record-agent-event.ts'
import { answerToolApproval } from '../operations/request-tool-approval.ts'
import { promptWaitingChats } from '../operations/retry-agent.ts'
import { interruptAgent } from '../operations/stop-agent.ts'

type AgentJob = Omit<Job, 'transact'>

const id = z.string().check(z.minLength(1))
const promptPayload = z.object({ messageId: z.pipe(id, z.transform(messageId)) })
const startSessionPayload = z.object({ chatId: z.pipe(id, z.transform(chatId)) })
const interruptPayload = z.object({
  chatId: z.pipe(id, z.transform(chatId)),
  promptId: z.pipe(id, z.transform(messageId)),
  memberId: z.pipe(id, z.transform(memberId)),
})
const memberRemovedPayload = z.object({
  memberId: z.pipe(id, z.transform(memberId)),
  actorId: z.pipe(id, z.transform(memberId)),
})

export const createAgentHandlers = ({
  transact,
  sandboxProvider,
  llm,
  classifier,
  eventSockets,
  now = Date.now,
  resumeAfterMilliseconds,
  approvalWindowMilliseconds,
  hqAgentImage,
  checkouts,
}: {
  transact: Transact
  sandboxProvider: SandboxProvider
  llm?: AgentLlm
  classifier?: SessionClassifier
  eventSockets: AgentEventSockets
  now?: () => number
  resumeAfterMilliseconds?: number
  approvalWindowMilliseconds?: number
  hqAgentImage?: string
  checkouts?: RepositoryCheckouts
}) => {
  const runtimes = createRuntimeAgentRuntimes(transact, sandboxProvider, { hqAgentImage })
  const agentClient = createHqAgentClient()
  const transactorOf = (id: WorkspaceId) => createTransactingZeroTransactor(transact, id)
  const dependenciesOf = (id: WorkspaceId) => ({
    transactor: transactorOf(id),
    runtimes,
    agentClient,
    eventSockets,
    classifier,
    checkouts,
    fixedLlm: llm,
    resumeAfterMilliseconds,
    approvalWindowMilliseconds,
  })
  return {
    jobs: {
      [agentJobTypes.prompt]: ({ workspaceId, payload, isLastAttempt }: AgentJob) =>
        promptAgent(dependenciesOf(workspaceId), {
          workspaceId,
          messageId: promptPayload.parse(payload).messageId,
          isLastAttempt,
        }),
      [agentJobTypes.startSession]: ({ workspaceId, payload }: AgentJob) =>
        startAgentSession(dependenciesOf(workspaceId), { workspaceId, ...startSessionPayload.parse(payload) }),
      [agentJobTypes.interrupt]: ({ workspaceId, payload }: AgentJob) =>
        interruptAgent(dependenciesOf(workspaceId), { workspaceId, ...interruptPayload.parse(payload) }),
      [agentJobTypes.sweep]: ({ workspaceId }: AgentJob) =>
        sweepAgentTurns(dependenciesOf(workspaceId), { workspaceId, now: now() }),
      [workspaceJobTypes.memberRemoved]: ({ workspaceId, payload }: AgentJob) =>
        interruptOwnedTurns(dependenciesOf(workspaceId), { workspaceId, ...memberRemovedPayload.parse(payload) }),
    },
    openEvents: async (chat: AgentChat, conversation: AgentConversation, listener: AgentEventListener) =>
      agentClient.openEvents(
        conversation,
        (await transactorOf(chat.workspaceId).run(({ agentEvents }) => agentEvents.last(chat.chatId))) ?? null,
        listener,
      ),
    recordEvent: async (chat: AgentChat, event: AgentEvent, turnPromptId?: MessageId) => {
      if (!isStoredAgentEvent(event)) return undefined
      const recorded = await recordAgentEvent(
        { transactor: transactorOf(chat.workspaceId) },
        { ...chat, event, turnPromptId },
      )
      if (recorded.expiredSignIn) await runtimes.expireSignIn(chat, recorded.expiredSignIn)
      await runtimes.touch(chat)
      return recorded
    },
    answerQuestion: async (chat: AgentChat, member: MemberId, questionId: string, answer: object) =>
      answerToolApproval(chat, member, questionId, answer) ??
      forwardToAgent(
        dependenciesOf(chat.workspaceId),
        { chat, memberId: member, permission: 'chat.post' },
        (conversation) => agentClient.answerQuestion(conversation, questionId, { ...answer, answeredBy: member }),
      ),
    setPlanMode: (chat: AgentChat, member: MemberId, enabled: boolean) =>
      forwardToAgent(
        dependenciesOf(chat.workspaceId),
        { chat, memberId: member, permission: 'session.configure' },
        (conversation) => agentClient.setPlanMode(conversation, enabled),
      ),
    reopenTarget: (chat: AgentChat) => reopenAgentTurn(dependenciesOf(chat.workspaceId), chat),
    closeReopenedTurn: (chat: AgentChat, promptId: MessageId, outcome: TurnOutcome) =>
      closeReopenedTurn(dependenciesOf(chat.workspaceId), { chat, promptId, outcome }),
    promptWaiting: (host: AgentHost) => promptWaitingChats(dependenciesOf(host.workspaceId), host),
    modelCallTurn: (host: AgentHost, token: string) => findModelCallTurn(dependenciesOf(host.workspaceId), host, token),
    toolCallTurn: (host: AgentHost, token: string) => findToolCallTurn(dependenciesOf(host.workspaceId), host, token),
    delegate: (input: Parameters<typeof delegateTask>[1]) =>
      delegateTask(dependenciesOf(input.chat.workspaceId), input),
    awaitTask: (input: Parameters<typeof awaitTask>[1]) => awaitTask(dependenciesOf(input.chat.workspaceId), input),
    recordModelCallFailure: (call: Parameters<typeof recordModelCallFailure>[1]) =>
      recordModelCallFailure(dependenciesOf(call.chat.workspaceId), call),
    authorizeToolCall: (
      input: Parameters<typeof authorizeToolCall>[1],
      checks: Parameters<typeof authorizeToolCall>[2],
    ) => authorizeToolCall(dependenciesOf(input.turn.chat.workspaceId), input, checks),
    recordToolCall: (workspace: WorkspaceId, call: Parameters<typeof recordToolCall>[1]) =>
      recordToolCall(dependenciesOf(workspace), call),
  }
}
