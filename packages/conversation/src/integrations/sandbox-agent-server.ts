import type {
  AgentConversation,
  AgentEndpoint,
  AgentLlmChoice,
  AgentServer,
  SubConversation,
} from '../contracts/agent.ts'
import type { AgentEvent } from '../domain/agent-events.ts'
import { condensationLimitsOf } from '../domain/masked-body.ts'
import type { Harness } from '../domain/session-routing.ts'
import { codexCommandOf } from './codex-launch.ts'

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

const harnessLaunchOf = (endpoint: AgentEndpoint, model: string) => ({
  'claude-code': {
    tokenName: 'ANTHROPIC_API_KEY',
    command: [
      'env',
      `ANTHROPIC_BASE_URL=${endpoint.transport.gatewayUrl.replace(/\/v1$/, '')}`,
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
      'CLAUDE_CODE_MAX_RETRIES=0',
      `ANTHROPIC_MODEL=${model}`,
      'claude-agent-acp',
    ],
  },
  codex: { tokenName: 'OPENAI_API_KEY', command: codexCommandOf(endpoint.transport.gatewayUrl, model) },
})

const harnessConversationOf = (
  endpoint: AgentEndpoint,
  llmToken: string,
  harness: Harness,
  { model, resumeSessionId }: AgentLlmChoice,
) => {
  const { tokenName, command } = harnessLaunchOf(endpoint, model)[harness]
  return {
    agent: {
      kind: 'ACPAgent',
      acp_server: harness,
      acp_command: command,
      mcp_config: { hq: mcpServerOf(endpoint, '/mcp', llmToken) },
      ...(resumeSessionId && { acp_resume_session_id: resumeSessionId }),
    },
    secrets: { [tokenName]: { kind: 'StaticSecret', value: llmToken } },
  }
}

const nativeConversationOf = (
  endpoint: AgentEndpoint,
  llmToken: string,
  llm: AgentLlmChoice,
  sub: SubConversation | undefined,
  condensationScale: number,
) => ({
  agent: {
    kind: 'Agent',
    llm: llmConfigOf(endpoint, llmToken, llm),
    condenser: {
      kind: 'LLMSummarizingCondenser',
      llm: {
        ...llmConfigOf(endpoint, llmToken, { model: llm.model, usageId: 'condenser' }),
        stream: false,
        extra_headers: { 'x-hq-role': 'condenser' },
      },
      max_size: condensationLimitsOf(condensationScale).condenserEvents,
      keep_first: 2,
    },
    tools: [{ name: 'terminal' }, { name: 'file_editor' }, { name: 'task_tracker' }],
    mcp_config: sub
      ? { hq: mcpServerOf(endpoint, '/mcp', sub.toolToken) }
      : { hq: mcpServerOf(endpoint, '/mcp', llmToken), router: mcpServerOf(endpoint, '/mcp/router', llmToken) },
  },
})

export const createSandboxAgentServer = (condensationScale = 1): AgentServer => ({
  createConversation: async (endpoint, llmToken, llm, sub) => {
    const created = await call(endpoint, 'POST', '/api/conversations', {
      ...(llm.harness
        ? harnessConversationOf(endpoint, llmToken, llm.harness, llm)
        : nativeConversationOf(endpoint, llmToken, llm, sub, condensationScale)),
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
  deleteConversation: async (conversation) => {
    await call(conversation, 'DELETE', `/api/conversations/${conversation.conversationId}`)
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
