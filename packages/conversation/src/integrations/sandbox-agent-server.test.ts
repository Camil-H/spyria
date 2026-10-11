import { expect, test } from 'bun:test'
import type { AgentEndpoint } from '../contracts/agent.ts'
import { createSandboxAgentServer } from './sandbox-agent-server.ts'

const createdBodyOf = async (harness: 'claude-code' | 'claude-code-subscription') => {
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
