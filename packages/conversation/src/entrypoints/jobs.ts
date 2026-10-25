import type { Job, Transact } from '@spyria/db/zero-queries'
import { chatId, log, type MemberId, type MessageId, memberId, messageId, type WorkspaceId } from '@spyria/kernel'
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
import type { WorkspaceRead } from '../domain/workspace-reads.ts'
import { createRuntimeAgentRuntimes, type SandboxProvider } from '../integrations/runtime-agent-runtimes.ts'
import { type AgentLlm, createSpyriaAgentClient } from '../integrations/spyria-agent-client.ts'
import { workspaceJobTypes } from '../integrations/workspace-jobs.ts'
import { createTransactingZeroTransactor } from '../integrations/zero-transactor.ts'
import { closeReopenedTurn, reopenAgentTurn, sweepAgentTurns } from '../operations/agent-turn-safety.ts'
import { authorizeToolCall } from '../operations/authorize-tool-call.ts'
import { awaitTask, delegateTask } from '../operations/delegate-task.ts'
import { forwardToAgent } from '../operations/forward-to-agent.ts'
import { runGitAction } from '../operations/git-actions.ts'
import { interruptOwnedTurns } from '../operations/interrupt-owned-turns.ts'
import {
  findModelCallTurn,
  findToolCallTurn,
  recordModelCallFailure,
  recordToolCall,
} from '../operations/model-calls.ts'
import { promptAgent, startAgentSession } from '../operations/prompt-agent.ts'
import { publishBranch, recordPullRequest } from '../operations/publish-branch.ts'
import { readRuntimeMedia, readWorkspace, snapshotWorkspace, wakeWorkspace } from '../operations/read-workspace.ts'
import { recordAgentEvent } from '../operations/record-agent-event.ts'
import { answerToolApproval } from '../operations/request-tool-approval.ts'
import { restartAgentSession } from '../operations/restart-session.ts'
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
const restartSessionPayload = z.object({
  chatId: z.pipe(id, z.transform(chatId)),
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
  spyriaAgentImage,
  checkouts,
  deployment,
}: {
  transact: Transact
  sandboxProvider: SandboxProvider
  llm?: AgentLlm
  classifier?: SessionClassifier
  eventSockets: AgentEventSockets
  now?: () => number
  resumeAfterMilliseconds?: number
  approvalWindowMilliseconds?: number
  spyriaAgentImage?: string
  checkouts?: RepositoryCheckouts
  deployment?: string
}) => {
  const runtimes = createRuntimeAgentRuntimes(transact, sandboxProvider, { spyriaAgentImage })
  const agentClient = createSpyriaAgentClient()
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
    deployment,
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
      [agentJobTypes.restartSession]: ({ workspaceId, payload }: AgentJob) =>
        restartAgentSession(dependenciesOf(workspaceId), { workspaceId, ...restartSessionPayload.parse(payload) }),
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
      if ((event.update as { sessionUpdate?: string } | undefined)?.sessionUpdate === 'turn_end')
        void snapshotWorkspace(dependenciesOf(chat.workspaceId), chat).catch((error) =>
          log.error({
            event: 'workspace_snapshot.failed',
            body: 'Keeping the workspace snapshot failed',
            attributes: { 'workspace.id': chat.workspaceId, 'chat.id': chat.chatId },
            error,
          }),
        )
      return recorded
    },
    readWorkspace: (chat: AgentChat, member: MemberId, read: WorkspaceRead, path: string) =>
      readWorkspace(dependenciesOf(chat.workspaceId), { chat, memberId: member, read, path }),
    readRuntimeMedia: (chat: AgentChat, member: MemberId, path: string) =>
      readRuntimeMedia(dependenciesOf(chat.workspaceId), { chat, memberId: member, path }),
    publishBranch: (input: Parameters<typeof publishBranch>[1]) =>
      publishBranch(dependenciesOf(input.chat.workspaceId), input),
    runGitAction: (input: Parameters<typeof runGitAction>[1]) =>
      runGitAction(dependenciesOf(input.chat.workspaceId), input),
    recordPullRequest: (input: Parameters<typeof recordPullRequest>[1]) =>
      recordPullRequest(dependenciesOf(input.chat.workspaceId), input),
    wakeWorkspace: (chat: AgentChat, member: MemberId) =>
      wakeWorkspace(dependenciesOf(chat.workspaceId), { chat, memberId: member }),
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
