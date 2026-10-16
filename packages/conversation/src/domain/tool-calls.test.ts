import { expect, test } from 'bun:test'
import { type AgentEvent, agentProjectionOf } from './agent-events.ts'
import { observedStep, type StoredStep } from './agent-steps.ts'
import { toolCallFailureOf, toolCallNoticeOf, toolConnectionOf, toolDisplayNameOf, toolServerOf } from './tool-calls.ts'

const authenticationRequired =
  'Authentication required for fake. Open this URL to connect your account: http://localhost:5190/gateway-oauth/workspace/mcp-sessions/auth?flow=c9b2227c-ecb2-4ece-864b-59fcdfa1cd88'
const revoked =
  'Tool execution failed: failed to establish ephemeral MCP connection: transport error: request failed with status 401: {"error":"invalid_token"}'
const notAllowed = "Tool execution failed: MCP tool 'fake-whoami' is not allowed for virtual key 'vk_3f0e'"
const serverDown =
  'Tool execution failed: failed to establish ephemeral MCP connection: transport error: request failed with status 503: down'
const crashed =
  'Tool execution failed: MCP tool call failed for fake-crash: internal error: The fake server crashed: mcp tool call failed'

test('an MCP tool name shows as the tool and its server', () => {
  expect(toolDisplayNameOf('fake-whoami')).toBe('whoami (fake)')
  expect(toolDisplayNameOf('GitHub-search_code')).toBe('search_code (GitHub)')
  expect(toolDisplayNameOf('mcp__router__delegate')).toBe('delegate')
  expect(toolDisplayNameOf('mcp__hq__fake-whoami')).toBe('whoami (fake)')
  expect(toolDisplayNameOf('Notion-notion-search')).toBe('notion-search (Notion)')
  expect(toolDisplayNameOf('terminal')).toBe('terminal')
  expect(toolServerOf('Notion-notion-search')).toBe('Notion')
})

test('tool errors the member must act on map to HQ wording, without the consent URL or key names', () => {
  expect(toolCallFailureOf(authenticationRequired)).toBe('needs_connection')
  expect(toolCallFailureOf(revoked)).toBe('needs_connection')
  expect(toolCallFailureOf(notAllowed)).toBe('not_allowed')
  expect(toolCallFailureOf(serverDown)).toBe('unavailable')
  expect(toolCallFailureOf(crashed)).toBeUndefined()
  expect(toolCallFailureOf('you are alice on oauth')).toBeUndefined()

  const names = { ownerName: 'Alice', server: 'fake' }
  expect(toolCallNoticeOf('needs_connection', { ...names, isReconnect: false })).toBe('Alice needs to connect fake')
  expect(toolCallNoticeOf('needs_connection', { ...names, isReconnect: true })).toBe('Alice needs to reconnect fake')
  expect(toolCallNoticeOf('not_allowed', { ...names, isReconnect: false })).toBe("fake isn't available for this chat")
  expect(toolCallNoticeOf('unavailable', { ...names, isReconnect: false })).toBe(
    'fake is unavailable, try again shortly',
  )
  for (const failure of ['needs_connection', 'not_allowed', 'unavailable'] as const) {
    const notice = toolCallNoticeOf(failure, { ...names, isReconnect: false })
    expect(notice).not.toContain('http')
    expect(notice).not.toContain('vk_')
  }
})

test('a connection notice in a tool result names the server and whether it is a reconnection', () => {
  expect(toolConnectionOf('Alice needs to connect fake')).toEqual({ server: 'fake', isReconnect: false })
  expect(toolConnectionOf('Alice D. needs to reconnect GitHub')).toEqual({ server: 'GitHub', isReconnect: true })
  expect(toolConnectionOf('you are alice on oauth')).toBeUndefined()
})

const mcpCall: AgentEvent = {
  id: 'conversation-1:1',
  kind: 'ACPUpdate',
  timestamp: '2026-10-07T10:00:00.000Z',
  seq: 1,
  completed: true,
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: 'call_1',
    title: 'mcp__hq__fake-whoami',
    kind: 'other',
    status: 'pending',
    rawInput: {},
  },
}
const mcpObservation = (text: string, isError = false) => ({ is_error: isError, content: [{ text }] })

test('an MCP tool call becomes a "Used <tool> (<server>)" step with its result, and a connection notice', () => {
  const projection = agentProjectionOf(mcpCall)
  expect(projection).toEqual({
    type: 'step',
    step: { type: 'tool', name: 'whoami (fake)', arguments: '{}', result: null },
    id: 'conversation-1:call_1',
  })
  const step = (projection as { step: StoredStep }).step
  expect(observedStep(step, mcpObservation('you are alice-acme on oauth'), 12)).toEqual({
    type: 'tool',
    name: 'whoami (fake)',
    arguments: '{}',
    result: 'you are alice-acme on oauth',
  })
  expect(observedStep(step, mcpObservation('Alice needs to reconnect fake', true), 12)).toEqual({
    type: 'tool',
    name: 'whoami (fake)',
    arguments: '{}',
    result: 'Alice needs to reconnect fake',
    isError: true,
    connection: { server: 'fake', isReconnect: true },
  })
})
