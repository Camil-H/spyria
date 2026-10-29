import { expect, test } from 'bun:test'
import type { HarnessId } from '@spyria/kernel'
import { type AgentConversation, AgentStartFailure } from '../contracts/agent.ts'
import { defaultResumeAfterMilliseconds, delegateTimeoutSeconds } from '../domain/delegation.ts'
import { piModelOf } from '../domain/session-routing.ts'
import { spyriaToolTimeoutSeconds, toolApprovalWindowMilliseconds } from '../domain/tool-calls.ts'
import { createSpyriaAgentClient, piCommandOf } from './spyria-agent-client.ts'

const requests: { method: string; path: string; body?: string }[] = []
const socketPaths: string[] = []
const endpoint: AgentConversation = {
  apiKey: 'session-key',
  conversationId: 'conversation-1',
  transport: {
    gatewayUrl: 'http://spyria-gateway-relay:4000/v1',
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
const createdBodyOf = async (harness: HarnessId, adapterModel?: string) => {
  requests.length = 0
  await createSpyriaAgentClient().createConversation(endpoint, 'runtime-token', { harness, adapterModel })
  return JSON.parse(requests[0]?.body ?? '{}')
}

test('a subscription session launches Claude Code without the relay, a model, or secrets, and keeps Spyria tools', async () => {
  const created = await createdBodyOf('claude-code')
  const command: string[] = created.agent.acp_command
  expect(command.at(-1)).toBe('claude-agent-acp')
  expect(command).toEqual(
    expect.arrayContaining(['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'CLAUDE_CODE_MAX_RETRIES=0']),
  )
  expect(created.secrets).toEqual({})
  expect(created.agent.mcp_config).toEqual({
    spyria: {
      url: 'http://spyria-gateway-relay:4000/mcp',
      transport: 'http',
      headers: { Authorization: 'Bearer runtime-token' },
    },
  })
  expect(JSON.stringify(created)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_API_KEY/)
})

test('Pi summarizes on its compaction model through its provider, starts at the routed thinking level and takes test compaction budgets', async () => {
  const anthropicCompaction = { ...piLaunch, compactionModel: 'anthropic/claude-haiku-5-5' }
  const command = piCommandOf('http://spyria-gateway-relay:4000/v1', anthropicCompaction, { sub: false })
  expect(command).toContain('SPYRIA_COMPACTION_MODEL=spyria-anthropic/anthropic/claude-haiku-5-5')
  const { created, envOf } = await createdPiOf(undefined, { effort: 'high' })
  expect(created.agent.acp_thought_level).toBe('high')
  expect((await createdPiOf(undefined, { effort: 'high', adapterModel: undefined })).created.agent).not.toHaveProperty(
    'acp_thought_level',
  )
  expect(JSON.parse(envOf('SPYRIA_PI_SETTINGS') ?? '')).not.toHaveProperty('compaction')
  const budgets = { reserveTokens: 3999, keepRecentTokens: 1 }
  const tested = piCommandOf(
    'http://spyria-gateway-relay:4000/v1',
    { ...piLaunch, compaction: budgets },
    { sub: false },
  )
  const settings = tested.find((part) => part.startsWith('SPYRIA_PI_SETTINGS='))?.slice('SPYRIA_PI_SETTINGS='.length)
  expect(JSON.parse(settings ?? '')).toMatchObject({
    extensions: ['/usr/local/lib/spyria/pi/spyria-compaction.ts', '/usr/local/lib/spyria/pi/spyria-tools.ts'],
    compaction: budgets,
  })
})

test('a model switch carries the thinking level only when one is given', async () => {
  requests.length = 0
  const conversation = { ...endpoint, conversationId: 'conversation-1' }
  await createSpyriaAgentClient().switchModel(conversation, 'spyria/openai/gpt-6.1-sol', 'high')
  await createSpyriaAgentClient().switchModel(conversation, 'spyria/mistral/mistral-small-latest')
  expect(requests.map(({ body }) => body)).toEqual([
    '{"model":"spyria/openai/gpt-6.1-sol","thoughtLevel":"high"}',
    '{"model":"spyria/mistral/mistral-small-latest"}',
  ])
})

test('a model picked for a subscription session is sent as acp_model, still without the relay or secrets, and switched in place', async () => {
  const created = await createdBodyOf('claude-code', 'sonnet')
  expect(created.agent.acp_model).toBe('sonnet')
  expect(created.secrets).toEqual({})
  expect(JSON.stringify(created)).not.toMatch(/ANTHROPIC_BASE_URL|ANTHROPIC_MODEL|ANTHROPIC_API_KEY|base_url/)
  expect((await createdBodyOf('claude-code')).agent).not.toHaveProperty('acp_model')
  requests.length = 0
  await createSpyriaAgentClient().switchModel({ ...endpoint, conversationId: 'conversation-1' }, 'haiku')
  expect(requests).toMatchObject([
    { path: '/api/conversations/conversation-1/switch_acp_model', body: '{"model":"haiku"}' },
  ])
})

test('a Codex subscription session writes its config atomically and launches without a relay, a provider, a model, or secrets', async () => {
  const created = await createdBodyOf('codex')
  const command: string[] = created.agent.acp_command
  const config = command.find((part) => part.startsWith('SPYRIA_CODEX_CONFIG=')) ?? ''
  expect(config).toContain('forced_login_method = "chatgpt"')
  expect(config).toMatch(/\[analytics\]\nenabled = false/)
  expect(config).toMatch(/\[feedback\]\nenabled = false/)
  const script = command.at(-1) ?? ''
  const temporary = '"$HOME/.codex/config.toml.$$"'
  expect(script).toContain(`> ${temporary}; mv ${temporary} "$HOME/.codex/config.toml"`)
  expect(script).toEndWith('exec codex-acp')
  expect(created.secrets).toEqual({})
  expect(created.agent.mcp_config).toEqual({
    spyria: expect.objectContaining({ headers: { Authorization: 'Bearer runtime-token' } }),
  })
  expect(JSON.stringify(created)).not.toMatch(
    /OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL|"CODEX_CONFIG=|MODEL_PROVIDER|base_url|model/,
  )
})

test('a spyria-agent session sends the bare ACP launch with its resume id, and resumes its socket after the last stored seq of that conversation only', async () => {
  const server = createSpyriaAgentClient()
  await server.createConversation(endpoint, 'runtime-token', {
    harness: 'claude-code',
    resumeSessionId: 'session-1',
  })
  const { id, agent, secrets } = JSON.parse(requests.at(-1)?.body ?? '{}')
  expect(id).toBe('conversation-1')
  expect(agent).toMatchObject({ acp_resume_session_id: 'session-1' })
  expect(agent).not.toHaveProperty('kind')
  expect(agent).not.toHaveProperty('acp_server')
  expect(secrets).toEqual({})

  const conversation = { ...endpoint, conversationId: 'conversation-1' }
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

test('a spyria-agent conversation that failed to start is deleted and reported with the adapter message', async () => {
  requests.length = 0
  const failed: AgentConversation = {
    ...endpoint,
    conversationId: 'conversation-9',
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
    createSpyriaAgentClient().createConversation(failed, 'runtime-token', { harness: 'claude-code' }),
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
const createdPiOf = async (sub?: { parentConversationId: string }, llm = {}) => {
  requests.length = 0
  await createSpyriaAgentClient().createConversation(
    endpoint,
    'runtime-llm-token',
    { pi: piLaunch, adapterModel: 'spyria-anthropic/anthropic/claude-sonnet-5-5', ...llm },
    sub,
  )
  const created = JSON.parse(requests[0]?.body ?? '{}')
  const command: string[] = created.agent.acp_command
  const envOf = (name: string) => command.find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1)
  const filesOf = (name: string) => JSON.parse(envOf(name) ?? '{}')
  return { created, command, envOf, models: filesOf('SPYRIA_PI_MODELS'), mcp: filesOf('SPYRIA_PI_MCP') }
}

test("a Pi launch passes the tokens only as secrets, runs offline, keeps its Anthropic prompt cache for an hour, writes its files atomically and execs Pi's RPC mode last", async () => {
  const { created, command, envOf } = await createdPiOf()
  expect(created.secrets).toEqual({
    SPYRIA_LLM_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
    SPYRIA_MCP_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
  })
  expect(created.agent.acp_model).toBe('spyria-anthropic/anthropic/claude-sonnet-5-5')
  expect(created.agent.adapter).toBe('pi-rpc')
  expect(created.agent).not.toHaveProperty('mcp_config')
  expect(JSON.stringify(command)).not.toContain('runtime-llm-token')
  expect(command.slice(0, 5)).toEqual([
    'env',
    'PI_OFFLINE=1',
    'PI_SKIP_VERSION_CHECK=1',
    'PI_TELEMETRY=0',
    'PI_CACHE_RETENTION=long',
  ])
  expect(envOf('SPYRIA_COMPACTION_MODEL')).toBe('spyria/mistral/mistral-small-latest')
  expect(JSON.parse(envOf('SPYRIA_PI_SETTINGS') ?? '')).toEqual({
    quietStartup: true,
    enableInstallTelemetry: false,
    retry: { enabled: false },
    extensions: ['/usr/local/lib/spyria/pi/spyria-compaction.ts', '/usr/local/lib/spyria/pi/spyria-tools.ts'],
  })
  const script = command.at(-1) ?? ''
  expect(command.slice(-3, -1)).toEqual(['sh', '-c'])
  expect(script).toContain('export PI_CODING_AGENT_DIR="$HOME/.pi/agent"')
  for (const file of ['models.json', 'settings.json', 'mcp.json'])
    expect(script).toContain(`write ${file} "$SPYRIA_PI_`)
  expect(script).toContain(
    '> "$PI_CODING_AGENT_DIR/$1.tmp"; mv "$PI_CODING_AGENT_DIR/$1.tmp" "$PI_CODING_AGENT_DIR/$1"',
  )
  expect(script.split('\n').at(-1)).toBe('exec pi --mode rpc --no-themes')
})

test('Pi lists Anthropic models on the Anthropic route without /v1 and the others on the chat route, with names, reasoning and context windows, the others without the long cache', async () => {
  const { models } = await createdPiOf()
  expect(models).toEqual({
    providers: {
      spyria: {
        baseUrl: 'http://spyria-gateway-relay:4000/v1',
        api: 'openai-completions',
        apiKey: `\${SPYRIA_LLM_TOKEN}`,
        models: [
          {
            id: 'openai/gpt-6.1-sol',
            name: 'GPT-6.1-Sol',
            reasoning: true,
            contextWindow: 1050000,
            compat: { supportsLongCacheRetention: false },
          },
          {
            id: 'mistral/mistral-small-latest',
            name: 'Mistral Small',
            reasoning: false,
            compat: { supportsLongCacheRetention: false, supportsDeveloperRole: false },
          },
        ],
      },
      'spyria-anthropic': {
        baseUrl: 'http://spyria-gateway-relay:4000',
        api: 'anthropic-messages',
        apiKey: `\${SPYRIA_LLM_TOKEN}`,
        models: [{ id: 'anthropic/claude-sonnet-5-5', name: 'Sonnet 5.5', reasoning: true, contextWindow: 200000 }],
      },
    },
  })
})

test.each([
  'openrouter/anthropic/claude-sonnet-5.5',
  'gemini/gemini-flash-latest',
  'xai/grok-4.3',
  'deepseek/deepseek-v4-flash',
  'zai/glm-4.7',
])('Pi reaches %s on the chat route with its full gateway id', (id) => {
  expect(piModelOf(id)).toBe(`spyria/${id}`)
  const command = piCommandOf(
    'http://spyria-gateway-relay:4000/v1',
    { models: [{ id, name: id, reasoning: true }], compactionModel: id },
    { sub: false },
  )
  const models = JSON.parse(
    command.find((part) => part.startsWith('SPYRIA_PI_MODELS='))?.slice('SPYRIA_PI_MODELS='.length) ?? '{}',
  )
  expect(models.providers).toEqual({
    spyria: expect.objectContaining({
      api: 'openai-completions',
      models: [
        { id, name: id, reasoning: true, compat: { supportsLongCacheRetention: false, supportsDeveloperRole: false } },
      ],
    }),
  })
  expect(command).toContain(`SPYRIA_COMPACTION_MODEL=spyria/${id}`)
})

test('a parent Pi reaches Spyria tools, web search and the router with its LLM token; a sub reaches only Spyria tools and web search with its own token from its own directory, on the default 5-minute cache', async () => {
  const parent = await createdPiOf()
  const toolServer = (path: string) => ({
    url: `http://spyria-gateway-relay:4000${path}`,
    headers: { Authorization: `Bearer \${SPYRIA_MCP_TOKEN}` },
    exposure: 'direct',
  })
  expect(parent.mcp).toEqual({
    mcpServers: {
      spyria: { ...toolServer('/mcp'), timeout: spyriaToolTimeoutSeconds },
      web: { ...toolServer('/mcp/web'), timeout: 120 },
      router: { ...toolServer('/mcp/router'), timeout: delegateTimeoutSeconds },
    },
  })
  const sub = await createdPiOf({ parentConversationId: 'conversation-1' })
  expect(sub.mcp).toEqual({
    mcpServers: {
      spyria: { ...toolServer('/mcp'), timeout: spyriaToolTimeoutSeconds },
      web: { ...toolServer('/mcp/web'), timeout: 120 },
    },
  })
  expect(sub.created.secrets).toEqual({
    SPYRIA_LLM_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
    SPYRIA_MCP_TOKEN: { kind: 'StaticSecret', value: 'runtime-llm-token' },
  })
  expect(JSON.stringify(sub.command)).not.toMatch(/runtime-llm-token/)
  expect(sub.command.at(-1)).toContain('export PI_CODING_AGENT_DIR="$HOME/.pi/sub"')
  expect(sub.command).not.toContain('PI_CACHE_RETENTION=long')
  expect(piCommandOf('http://spyria-gateway-relay:4000/v1', piLaunch, { sub: true })).toEqual(sub.command)
})

test('a parent Pi in a dev chat also reaches the GitHub tools; a sub never does', () => {
  const mcpOf = (command: string[]) =>
    JSON.parse(command.find((part) => part.startsWith('SPYRIA_PI_MCP='))?.slice('SPYRIA_PI_MCP='.length) ?? '{}')
      .mcpServers
  const gateway = 'http://spyria-gateway-relay:4000/v1'
  expect(mcpOf(piCommandOf(gateway, piLaunch, { sub: false, hasRepository: true })).github).toEqual({
    url: 'http://spyria-gateway-relay:4000/mcp/github',
    headers: { Authorization: `Bearer \${SPYRIA_MCP_TOKEN}` },
    exposure: 'direct',
    timeout: 120,
  })
  expect(Object.keys(mcpOf(piCommandOf(gateway, piLaunch, { sub: true, hasRepository: true })))).toEqual([
    'spyria',
    'web',
  ])
  expect(Object.keys(mcpOf(piCommandOf(gateway, piLaunch, { sub: false })))).toEqual(['spyria', 'web', 'router'])
})

test('the router answers a running delegation well before Pi gives up on the delegate call', () => {
  const piDefaultMcpTimeoutMilliseconds = 60_000
  expect(delegateTimeoutSeconds * 1000).toBeGreaterThan(piDefaultMcpTimeoutMilliseconds)
  expect(defaultResumeAfterMilliseconds).toBeLessThan(piDefaultMcpTimeoutMilliseconds)
})

test('a tool call waiting for the owner’s approval is decided before Pi gives up on it', () => {
  expect(spyriaToolTimeoutSeconds * 1000).toBeGreaterThan(toolApprovalWindowMilliseconds)
  expect(delegateTimeoutSeconds).toBe(120)
})
