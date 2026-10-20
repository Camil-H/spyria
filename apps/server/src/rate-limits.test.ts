import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type LogEvent, setLogOutput } from '@spyria/kernel'
import { clientAddressOf, createRateLimiter, limitOfMutation, RateLimited, rateBudgets } from './rate-limits.ts'

beforeEach(() => setLogOutput(() => {}))
afterEach(() => setLogOutput(undefined))

const clock = () => {
  let at = 1_000_000
  return { now: () => at, advance: (milliseconds: number) => (at += milliseconds) }
}
const refusalOf = (take: () => void) => {
  try {
    take()
  } catch (error) {
    if (error instanceof RateLimited) return error
    throw error
  }
}

test('a budget lets its count through, then refuses with the seconds until one more is refilled', () => {
  const time = clock()
  const limit = createRateLimiter(rateBudgets, time.now)
  for (let request = 0; request < 10; request++) limit('emailRouting', { address: '203.0.113.7' })
  expect(refusalOf(() => limit('emailRouting', { address: '203.0.113.7' }))).toMatchObject({
    code: 'rate_limited',
    retryAfterSeconds: 6,
    message: 'Too many requests: try again in 6 seconds.',
  })
  time.advance(6_000)
  expect(refusalOf(() => limit('emailRouting', { address: '203.0.113.7' }))).toBeUndefined()
  expect(refusalOf(() => limit('emailRouting', { address: '203.0.113.7' }))).toBeInstanceOf(RateLimited)
  time.advance(60_000)
  for (let request = 0; request < 10; request++) limit('emailRouting', { address: '203.0.113.7' })
})

test('addresses, workspaces, members and limit names have separate buckets', () => {
  const limit = createRateLimiter(rateBudgets, clock().now)
  for (let request = 0; request < 3; request++) limit('verificationEmails', { workspaceId: 'acme', userId: 'alice' })
  expect(refusalOf(() => limit('verificationEmails', { workspaceId: 'acme', userId: 'bob' }))).toBeInstanceOf(
    RateLimited,
  )
  expect(refusalOf(() => limit('verificationEmails', { workspaceId: 'globex', userId: 'alice' }))).toBeUndefined()
  for (let request = 0; request < 10; request++) limit('runtimeCreation', { workspaceId: 'acme', userId: 'alice' })
  expect(refusalOf(() => limit('runtimeCreation', { workspaceId: 'acme', userId: 'bob' }))).toBeUndefined()
  expect(refusalOf(() => limit('runtimeCreation', { workspaceId: 'globex', userId: 'alice' }))).toBeUndefined()
  expect(refusalOf(() => limit('prompts', { workspaceId: 'acme', userId: 'alice' }))).toBeUndefined()
  for (let request = 0; request < 10; request++) limit('emailRouting', { address: '203.0.113.7' })
  expect(refusalOf(() => limit('emailRouting', { address: '198.51.100.2' }))).toBeUndefined()
})

test('a hit logs one rate_limit.hit line with the limit name and ids, never the address', () => {
  const events: LogEvent[] = []
  setLogOutput((_, logEvent) => events.push(logEvent))
  const limit = createRateLimiter({ ...rateBudgets, prompts: { ...rateBudgets.prompts, count: 1 } }, clock().now)
  limit('prompts', { address: '203.0.113.7', workspaceId: 'acme', userId: 'alice' })
  refusalOf(() => limit('prompts', { address: '203.0.113.7', workspaceId: 'acme', userId: 'alice' }))
  limit('signInCallback', { address: '203.0.113.7' })
  expect(events).toEqual([
    {
      event: 'rate_limit.hit',
      body: 'A rate limit was hit',
      attributes: { 'rate_limit.name': 'prompts', 'workspace.id': 'acme', 'user.id': 'alice' },
    },
  ])
})

test('CF-Connecting-IP is the client address only behind Cloudflare, else the socket address', () => {
  const request = new Request('http://spyria.test/auth/login', { headers: { 'cf-connecting-ip': '203.0.113.7' } })
  expect(clientAddressOf(request, '10.0.0.5', 'cloudflare')).toBe('203.0.113.7')
  expect(clientAddressOf(request, '10.0.0.5', undefined)).toBe('10.0.0.5')
  expect(clientAddressOf(new Request('http://spyria.test/'), '10.0.0.5', 'cloudflare')).toBe('10.0.0.5')
})

test('invites, prompts and runtime or fork creation are the limited mutations', () => {
  expect(limitOfMutation('workspace.inviteMember', {})).toBe('invites')
  expect(limitOfMutation('conversation.sendMessage', {})).toBe('prompts')
  expect(limitOfMutation('conversation.forkChat', {})).toBe('runtimeCreation')
  expect(limitOfMutation('workspace.createChat', { type: 'runtime' })).toBe('runtimeCreation')
  expect(limitOfMutation('workspace.createChat', { type: 'channel' })).toBeUndefined()
  expect(limitOfMutation('conversation.markChatRead', {})).toBeUndefined()
})
