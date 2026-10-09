import type { AgentConversation, AgentEndpoint, AgentLlmChoice, AgentServer } from '../contracts/agent.ts'
import type { AgentEvent } from '../domain/agent-events.ts'

export type AgentLlm = { model: string }

const requestTimeoutMilliseconds = 30_000
const notFoundStatus = 404

const call = async (endpoint: AgentEndpoint, method: string, path: string, body?: object) => {
  const response = await endpoint.transport.fetch({
    method,
    path,
    headers: { 'content-type': 'application/json', 'x-session-api-key': endpoint.apiKey },
    body: body && JSON.stringify(body),
    timeoutMilliseconds: requestTimeoutMilliseconds,
  })
  if (response.status === notFoundStatus && method === 'GET') return undefined
  if (response.status >= 300) throw new Error(`The Agent Server answered ${method} ${path} with ${response.status}`)
  return JSON.parse(response.body || '{}') as Record<string, unknown>
}

const eventOf = (data: string): AgentEvent | undefined => {
  try {
    const event = JSON.parse(data)
    return typeof event?.id === 'string' && typeof event.kind === 'string' && typeof event.timestamp === 'string'
      ? event
      : undefined
  } catch {
    return undefined
  }
}

const llmConfigOf = (endpoint: AgentEndpoint, llmToken: string, { model, effort, usageId }: AgentLlmChoice) => ({
  usage_id: usageId,
  model,
  base_url: endpoint.transport.gatewayUrl,
  api_key: llmToken,
  stream: true,
  api_mode: 'chat',
  num_retries: 0,
  ...(effort && { reasoning_effort: effort }),
})

const mcpServerOf = (endpoint: AgentEndpoint, path: string, token: string) => ({
  url: endpoint.transport.gatewayUrl.replace(/\/v1$/, path),
  transport: 'http',
  headers: { Authorization: `Bearer ${token}` },
})

export const createSandboxAgentServer = (): AgentServer => ({
  createConversation: async (endpoint, llmToken, llm, sub) => {
    const created = await call(endpoint, 'POST', '/api/conversations', {
      agent: {
        kind: 'Agent',
        llm: llmConfigOf(endpoint, llmToken, llm),
        tools: [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }],
        mcp_config: sub
          ? { hq: mcpServerOf(endpoint, '/mcp', sub.toolToken) }
          : { hq: mcpServerOf(endpoint, '/mcp', llmToken), router: mcpServerOf(endpoint, '/mcp/router', llmToken) },
      },
      workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
      autotitle: false,
      ...(sub && { parent_conversation_id: sub.parentConversationId }),
    })
    return String(created?.id)
  },
  finalResponse: async (conversation) =>
    String(
      (await call(conversation, 'GET', `/api/conversations/${conversation.conversationId}/agent_final_response`))
        ?.response ?? '',
    ),
  switchLlm: async (conversation, llmToken, llm) => {
    await call(conversation, 'POST', `/api/conversations/${conversation.conversationId}/switch_llm`, {
      llm: llmConfigOf(conversation, llmToken, llm),
    })
  },
  sendMessage: async (conversation, text) => {
    await call(conversation, 'POST', `/api/conversations/${conversation.conversationId}/events`, {
      role: 'user',
      content: [{ type: 'text', text }],
      run: true,
    })
  },
  statusOf: async (conversation) => {
    const read = await call(conversation, 'GET', `/api/conversations/${conversation.conversationId}`)
    return read && String(read.execution_status)
  },
  interrupt: async (conversation) => {
    await call(conversation, 'POST', `/api/conversations/${conversation.conversationId}/interrupt`, {})
  },
  openEvents: (conversation: AgentConversation, afterTimestamp, listener) => {
    const resend = afterTimestamp
      ? `resend_mode=since&after_timestamp=${encodeURIComponent(afterTimestamp)}`
      : 'resend_mode=all'
    const socket = conversation.transport.openSocket(`/sockets/events/${conversation.conversationId}?${resend}`, {
      onOpen: () => socket.send(JSON.stringify({ type: 'auth', session_api_key: conversation.apiKey })),
      onMessage: (data) => {
        const event = eventOf(data)
        if (event) listener.onEvent(event)
      },
      onClose: listener.onClose,
    })
    return socket
  },
})
