import { expect, test } from 'bun:test'
import { type AgentEndpoint, AgentStartFailure } from '../contracts/agent.ts'
import type { HarnessLaunch } from '../domain/session-routing.ts'
import { createSandboxAgentServer } from './sandbox-agent-server.ts'

const requests: { method: string; path: string; body?: string }[] = []
const socketPaths: string[] = []
const endpoint: AgentEndpoint = {
  apiKey: 'session-key',
  conversationId: null,
  isHqAgent: false,
  transport: {
    gatewayUrl: 'http://hq-gateway-relay:4000/v1',
    fetch: async (request) => {
      requests.push(request)
      return { status: 201, body: JSON.stringify({ id: 'conversation-1' }) }
    },
    openSocket: (path) => {
      socketPaths.push(path)
      return { send: () => {}, close: () => {} }
    },
  },
}
const createdBodyOf = async (harness: HarnessLaunch, acpModel?: string) => {
  requests.length = 0
  await createSandboxAgentServer().createConversation(endpoint, 'runtime-token', {
    model: 'claude-opus-5-5',
    usageId: 'agent',
    harness,
    acpModel,
  })
  return JSON.parse(requests[0]?.body ?? '{}')
}

test('a subscription session launches Claude Code without the relay, a model, or secrets, and keeps HQ tools', async () => {
  const created = await createdBodyOf('claude-code-subscription')
  expect(created.agent.acp_server).toBe('claude-code')
  expect(created.agent.acp_command).toEqual([
    'env',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
    'CLAUDE_CODE_MAX_RETRIES=0',
    'claude-agent-acp',
  ])
  expect(created.secrets).toEqual({})
  expect(created.agent.mcp_config).toEqual({
    hq: {
      url: 'http://hq-gateway-relay:4000/mcp',
      transport: 'http',
      headers: { Authorization: 'Bearer runtime-token' },
    },
  })
  expect(JSON.stringify(created)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_API_KEY/)
})

test('a model picked for a subscription session is sent as acp_model, still without the relay or secrets, and switched in place', async () => {
  const created = await createdBodyOf('claude-code-subscription', 'sonnet')
  expect(created.agent.acp_model).toBe('sonnet')
  expect(created.secrets).toEqual({})
  expect(JSON.stringify(created)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_API_KEY|base_url/)
  expect((await createdBodyOf('claude-code-subscription')).agent).not.toHaveProperty('acp_model')
  requests.length = 0
  await createSandboxAgentServer().switchAcpModel({ ...endpoint, conversationId: 'conversation-1' }, 'haiku')
  expect(requests).toMatchObject([
    { path: '/api/conversations/conversation-1/switch_acp_model', body: '{"model":"haiku"}' },
  ])
})

test('the API-key Claude Code launch keeps the relay, the model and its token secret', async () => {
  const created = await createdBodyOf('claude-code')
  expect(created.agent.acp_command).toContain('ANTHROPIC_BASE_URL=http://hq-gateway-relay:4000')
  expect(created.agent.acp_command).toContain('ANTHROPIC_MODEL=claude-opus-5-5')
  expect(Object.keys(created.secrets)).toEqual(['ANTHROPIC_API_KEY'])
})

test('a Codex subscription session writes its config atomically and launches without a relay, a provider, a model, or secrets', async () => {
  const created = await createdBodyOf('codex-subscription')
  const [env, config, ...launcher] = created.agent.acp_command
  expect(created.agent.acp_server).toBe('codex')
  expect([env, ...launcher]).toEqual([
    'env',
    'sh',
    '-c',
    'set -e; printf %s "$HQ_CODEX_CONFIG" > "$HOME/.codex/config.toml.$$"; mv "$HOME/.codex/config.toml.$$" "$HOME/.codex/config.toml"; exec codex-acp',
  ])
  expect(config).toBe(`HQ_CODEX_CONFIG=forced_login_method = "chatgpt"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[analytics]
enabled = false

[feedback]
enabled = false

[features]
plugins = false
remote_plugin = false
apps = false
`)
  expect(created.secrets).toEqual({})
  expect(Object.keys(created.agent.mcp_config)).toEqual(['hq'])
  expect(JSON.stringify(created)).not.toMatch(
    /OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|"CODEX_CONFIG=|MODEL_PROVIDER|base_url|model/,
  )
})

test('an hq-agent session sends the bare ACP launch with its resume id, and resumes its socket after the last stored seq of that conversation only', async () => {
  const hqAgent = { ...endpoint, isHqAgent: true }
  const server = createSandboxAgentServer()
  await server.createConversation(hqAgent, 'runtime-token', {
    model: '',
    usageId: 'agent',
    harness: 'claude-code-subscription',
    resumeSessionId: 'session-1',
  })
  const { agent, secrets } = JSON.parse(requests.at(-1)?.body ?? '{}')
  expect(agent).toMatchObject({ acp_resume_session_id: 'session-1' })
  expect(agent).not.toHaveProperty('kind')
  expect(agent).not.toHaveProperty('acp_server')
  expect(secrets).toEqual({})

  const conversation = { ...hqAgent, conversationId: 'conversation-1' }
  const listener = { onEvent: () => {}, onClose: () => {} }
  const timestamp = '2026-10-12T17:56:00.000Z'
  socketPaths.length = 0
  server.openEvents(conversation, { id: 'conversation-1:7', seq: 7, timestamp }, listener)
  server.openEvents(conversation, { id: 'conversation-0:9', seq: 9, timestamp }, listener)
  server.openEvents(conversation, null, listener)
  expect(socketPaths).toEqual([
    '/sockets/events/conversation-1?after=7',
    '/sockets/events/conversation-1?after=0',
    '/sockets/events/conversation-1?after=0',
  ])
})

test('an hq-agent conversation that failed to start is deleted and reported with the adapter message', async () => {
  requests.length = 0
  const failed: AgentEndpoint = {
    ...endpoint,
    isHqAgent: true,
    transport: {
      ...endpoint.transport,
      fetch: async (request) => {
        requests.push(request)
        return {
          status: 201,
          body: JSON.stringify({ id: 'conversation-9', execution_status: 'error', error: 'Authentication required' }),
        }
      },
    },
  }
  await expect(
    createSandboxAgentServer().createConversation(failed, 'runtime-token', {
      model: '',
      usageId: 'agent',
      harness: 'claude-code-subscription',
    }),
  ).rejects.toEqual(new AgentStartFailure('Authentication required'))
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    'POST /api/conversations',
    'DELETE /api/conversations/conversation-9',
  ])
})
