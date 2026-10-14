import { expect, test } from 'bun:test'
import { type AgentEndpoint, AgentStartFailure } from '../contracts/agent.ts'
import type { HarnessLaunch } from '../domain/session-routing.ts'
import { createSandboxAgentServer, piCommandOf } from './sandbox-agent-server.ts'

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

const piLaunch = {
  models: [
    { id: 'anthropic/claude-sonnet-5-5', name: 'Sonnet 5.5', reasoning: true, contextWindow: 200000 },
    { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: true, contextWindow: 1050000 },
    { id: 'mistral/mistral-small-latest', name: 'Mistral Small', reasoning: false },
  ],
  compactionModel: 'mistral/mistral-small-latest',
}
const createdPiOf = async (sub?: { parentConversationId: string; toolToken: string }) => {
  requests.length = 0
  await createSandboxAgentServer().createConversation(
    { ...endpoint, isHqAgent: true },
    'runtime-llm-token',
    { model: '', usageId: 'agent', pi: piLaunch, acpModel: 'hq-anthropic/anthropic/claude-sonnet-5-5' },
    sub,
  )
  const created = JSON.parse(requests[0]?.body ?? '{}')
  const command: string[] = created.agent.acp_command
  const envOf = (name: string) => command.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
  const filesOf = (name: string) => JSON.parse(envOf(name) ?? '{}')
  return { created, command, envOf, models: filesOf('HQ_PI_MODELS'), mcp: filesOf('HQ_PI_MCP') }
}

test('a Pi launch passes the tokens only as secrets, runs offline, writes its files atomically and execs pi-acp last', async () => {
  const { created, command, envOf } = await createdPiOf()
  expect(created.secrets).toEqual({
    HQ_LLM_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
    HQ_MCP_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
  })
  expect(created.agent.acp_model).toBe('hq-anthropic/anthropic/claude-sonnet-5-5')
  expect(created.agent).not.toHaveProperty('mcp_config')
  expect(JSON.stringify(command)).not.toContain('runtime-llm-token')
  expect(command.slice(0, 5)).toEqual([
    'env',
    'PI_OFFLINE=1',
    'PI_SKIP_VERSION_CHECK=1',
    'PI_TELEMETRY=0',
    'npm_config_offline=true',
  ])
  expect(envOf('HQ_COMPACTION_MODEL')).toBe('mistral/mistral-small-latest')
  expect(JSON.parse(envOf('HQ_PI_SETTINGS') ?? '')).toEqual({
    quietStartup: true,
    enableInstallTelemetry: false,
    retry: { enabled: false },
  })
  const script = command.at(-1) ?? ''
  expect(command.slice(-3, -1)).toEqual(['sh', '-c'])
  expect(script).toContain('export PI_CODING_AGENT_DIR="$HOME/.pi/agent"')
  for (const file of ['models.json', 'settings.json', 'mcp.json']) expect(script).toContain(`write ${file} "$HQ_PI_`)
  expect(script).toContain(
    '> "$PI_CODING_AGENT_DIR/$1.tmp"; mv "$PI_CODING_AGENT_DIR/$1.tmp" "$PI_CODING_AGENT_DIR/$1"',
  )
  expect(script.split('\n').at(-1)).toBe('exec pi-acp')
})

test('Pi lists Anthropic models on the Anthropic route without /v1 and the others on the chat route, with names, reasoning and context windows', async () => {
  const { models } = await createdPiOf()
  expect(models).toEqual({
    providers: {
      hq: {
        baseUrl: 'http://hq-gateway-relay:4000/v1',
        api: 'openai-completions',
        apiKey: `\${HQ_LLM_TOKEN}`,
        models: [
          { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1-Sol', reasoning: true, contextWindow: 1050000 },
          {
            id: 'mistral/mistral-small-latest',
            name: 'Mistral Small',
            reasoning: false,
            compat: { supportsDeveloperRole: false },
          },
        ],
      },
      'hq-anthropic': {
        baseUrl: 'http://hq-gateway-relay:4000',
        api: 'anthropic-messages',
        apiKey: `\${HQ_LLM_TOKEN}`,
        models: [{ id: 'anthropic/claude-sonnet-5-5', name: 'Sonnet 5.5', reasoning: true, contextWindow: 200000 }],
      },
    },
  })
})

test('a parent Pi reaches HQ tools and the router with its LLM token; a sub reaches only HQ tools with its tool token from its own directory', async () => {
  const parent = await createdPiOf()
  const toolServer = (path: string) => ({
    url: `http://hq-gateway-relay:4000${path}`,
    headers: { Authorization: `Bearer \${HQ_MCP_TOKEN}` },
    exposure: 'direct',
  })
  expect(parent.mcp).toEqual({ mcpServers: { hq: toolServer('/mcp'), router: toolServer('/mcp/router') } })
  const sub = await createdPiOf({ parentConversationId: 'conversation-1', toolToken: 'sub-tool-token' })
  expect(sub.mcp).toEqual({ mcpServers: { hq: toolServer('/mcp') } })
  expect(sub.created.secrets).toEqual({
    HQ_LLM_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
    HQ_MCP_TOKEN: { kind: 'StaticSecret', value: 'sub-tool-token' },
  })
  expect(JSON.stringify(sub.command)).not.toMatch(/sub-tool-token|runtime-llm-token/)
  expect(sub.command.at(-1)).toContain('export PI_CODING_AGENT_DIR="$HOME/.pi/sub"')
  expect(piCommandOf('http://hq-gateway-relay:4000/v1', piLaunch, { sub: true })).toEqual(sub.command)
})
