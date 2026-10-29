import { expect, test } from 'bun:test'
import { ToolNotInCatalog } from './errors.ts'
import { checkedConnectionStatusOf, connectedTool, connectionStatusOf } from './personal-connection.ts'

const catalog = ['GitHub', 'Slack', 'Linear']

test('the connection status follows the gateway sessions of the member key', () => {
  expect(connectionStatusOf(['active'])).toBe('Connected')
  expect(connectionStatusOf(['needs_reauth'])).toBe('Needs reconnection')
  expect(connectionStatusOf(['needs_reauth', 'active'])).toBe('Connected')
  expect(connectionStatusOf(['orphaned'])).toBeUndefined()
  expect(connectionStatusOf([])).toBeUndefined()
})

test('connectedTool connects a tool of the catalog and rejects others', () => {
  expect(connectedTool('Linear', catalog)).toEqual({ tool: 'Linear', status: 'Connected' })
  expect(() => connectedTool('Jira', catalog)).toThrow(ToolNotInCatalog)
})

test('a checked connection reads Connected only when its session is active and a read-only call, if any, went through', () => {
  const active = { sessionStatus: 'Connected', storedStatus: 'Connected' } as const
  expect(checkedConnectionStatusOf({ ...active, isAuthorized: true })).toBe('Connected')
  expect(checkedConnectionStatusOf({ ...active, isAuthorized: false })).toBe('Needs reconnection')
  expect(checkedConnectionStatusOf({ ...active, isAuthorized: undefined })).toBe('Connected')
  expect(checkedConnectionStatusOf({ ...active, isAuthorized: undefined, storedStatus: 'Needs reconnection' })).toBe(
    'Needs reconnection',
  )
  expect(
    checkedConnectionStatusOf({
      sessionStatus: 'Needs reconnection',
      isAuthorized: undefined,
      storedStatus: 'Connected',
    }),
  ).toBe('Needs reconnection')
  expect(
    checkedConnectionStatusOf({ sessionStatus: undefined, isAuthorized: undefined, storedStatus: 'Connected' }),
  ).toBeUndefined()
})
