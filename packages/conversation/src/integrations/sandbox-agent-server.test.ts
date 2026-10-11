import { expect, test } from 'bun:test'
import type { AgentEndpoint } from '../contracts/agent.ts'
import type { HarnessLaunch } from '../domain/session-routing.ts'
import { createSandboxAgentServer } from './sandbox-agent-server.ts'

const createdBodyOf = async (harness: HarnessLaunch) => {
  const requests: { path: string; body?: string }[] = []
  const endpoint: AgentEndpoint = {
    apiKey: 'session-key',
    conversationId: null,
    transport: {
      gatewayUrl: 'http://hq-gateway-relay:4000/v1',
      fetch: async (request) => {
        requests.push(request)
        return { status: 201, body: JSON.stringify({ id: 'conversation-1' }) }
      },
      openSocket: () => ({ send: () => {}, close: () => {} }),
    },
  }
  await createSandboxAgentServer().createConversation(endpoint, 'runtime-token', {
    model: 'claude-opus-5-5',
    usageId: 'agent',
    harness,
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
