import { messageId, type WorkspaceId } from '@hq/kernel'
import { z } from 'zod/mini'
import type { AgentChat, AgentConversation, AgentEventListener, AgentEventSockets } from '../contracts/agent.ts'
import { type AgentEvent, isStoredAgentEvent } from '../domain/agent-events.ts'
import { createRuntimeAgentRuntimes, type SandboxProvider } from '../integrations/runtime-agent-runtimes.ts'
import { type AgentLlm, createSandboxAgentServer } from '../integrations/sandbox-agent-server.ts'
import { agentPromptJobType, createTransactingZeroTransactor, type Transact } from '../integrations/zero-transactor.ts'
import { promptAgent } from '../operations/prompt-agent.ts'
import { recordAgentEvent } from '../operations/record-agent-event.ts'

type Job = { workspaceId: WorkspaceId; payload: unknown }

const promptPayload = z.object({ messageId: z.pipe(z.string().check(z.minLength(1)), z.transform(messageId)) })

export const createAgentHandlers = ({
  transact,
  sandboxProvider,
  llm,
  eventSockets,
}: {
  transact: Transact
  sandboxProvider: SandboxProvider
  llm: AgentLlm
  eventSockets: AgentEventSockets
}) => {
  const runtimes = createRuntimeAgentRuntimes(transact, sandboxProvider)
  const agentServer = createSandboxAgentServer(llm)
  const transactorOf = (id: WorkspaceId) => createTransactingZeroTransactor(transact, id)
  return {
    jobs: {
      [agentPromptJobType]: ({ workspaceId, payload }: Job) =>
        promptAgent(
          { transactor: transactorOf(workspaceId), runtimes, agentServer, eventSockets },
          { workspaceId, messageId: promptPayload.parse(payload).messageId },
        ),
    },
    openEvents: async (chat: AgentChat, conversation: AgentConversation, listener: AgentEventListener) =>
      agentServer.openEvents(
        conversation,
        await transactorOf(chat.workspaceId).run(({ agentEvents }) => agentEvents.lastTimestamp(chat.chatId)),
        listener,
      ),
    recordEvent: async (chat: AgentChat, event: AgentEvent) => {
      if (!isStoredAgentEvent(event)) return undefined
      const recorded = await recordAgentEvent({ transactor: transactorOf(chat.workspaceId) }, { ...chat, event })
      await runtimes.touch(chat)
      return recorded
    },
    reopenTarget: async (chat: AgentChat) => {
      const promptId = await transactorOf(chat.workspaceId).run(({ agentTurns }) => agentTurns.lock(chat.chatId))
      const endpoint = promptId === null ? undefined : await runtimes.endpointOf(chat)
      const conversationId = endpoint?.conversationId
      return endpoint && conversationId && promptId
        ? { conversation: { ...endpoint, conversationId }, promptId }
        : undefined
    },
  }
}
