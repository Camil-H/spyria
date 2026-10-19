import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@spyria/kernel'
import { ToolNotInCatalog } from './errors.ts'
import { connectedTool, connectionStatusOf } from './personal-connection.ts'

const owner = { workspaceId: workspaceId('acme'), memberId: memberId('alice') }
const catalog = ['GitHub', 'Slack', 'Linear']

test('the connection status follows the gateway sessions of the member key', () => {
  expect(connectionStatusOf(['active'])).toBe('Connected')
  expect(connectionStatusOf(['needs_reauth'])).toBe('Needs reconnection')
  expect(connectionStatusOf(['needs_reauth', 'active'])).toBe('Connected')
  expect(connectionStatusOf(['orphaned'])).toBeUndefined()
  expect(connectionStatusOf([])).toBeUndefined()
})

test('connectedTool connects a tool of the catalog and rejects others', () => {
  expect(connectedTool(owner, 'Linear', catalog)).toEqual({ ...owner, tool: 'Linear', status: 'Connected' })
  expect(() => connectedTool(owner, 'Jira', catalog)).toThrow(ToolNotInCatalog)
})
