import { expect, test } from 'bun:test'
import { githubConnectionStatusOf } from './github-connection.ts'

test('a GitHub connection reads Not connected, Connected with its login, or Needs reconnection', () => {
  expect(githubConnectionStatusOf(null)).toBe('Not connected')
  expect(githubConnectionStatusOf({ login: 'alice-martin', state: 'connected' })).toBe('Connected (alice-martin)')
  expect(githubConnectionStatusOf({ login: 'alice-martin', state: 'needs_reconnection' })).toBe('Needs reconnection')
})
