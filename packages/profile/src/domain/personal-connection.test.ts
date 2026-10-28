import { expect, test } from 'bun:test'
import { ToolNotInCatalog } from './errors.ts'
import { connectedTool, connectionStatusOf } from './personal-connection.ts'

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
