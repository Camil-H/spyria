import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@spyria/kernel'
import {
  allowedAfterRelisting,
  connectionInputOf,
  gatewayNameOf,
  knownToolsOf,
  memberToolsOf,
  type WorkspaceConnection,
} from './workspace-connection.ts'

const crm: WorkspaceConnection = {
  workspaceId: workspaceId('workspace-acme'),
  id: 'connection-crm',
  name: 'CRM',
  gatewayName: 'crm_1a2b3c',
  url: 'https://crm.example/mcp',
  headerName: null,
  tools: [
    { name: 'lookup', readOnly: true },
    { name: 'update', readOnly: false },
    { name: 'delete', readOnly: false },
  ],
  allowedTools: ['lookup', 'update'],
}
const bob = memberId('member-bob')

test('a connection needs a name, an http URL and, when a secret header is given, its name and value', () => {
  expect(connectionInputOf({ name: ' CRM ', url: 'https://crm.example/mcp' })).toEqual({
    name: 'CRM',
    url: 'https://crm.example/mcp',
    secretHeader: undefined,
  })
  expect(() => connectionInputOf({ name: ' ', url: 'https://crm.example/mcp' })).toThrow('A connection needs a name')
  expect(() => connectionInputOf({ name: 'CRM', url: 'ftp://crm.example' })).toThrow('http or https')
  expect(() =>
    connectionInputOf({ name: 'CRM', url: 'https://crm.example/mcp', secretHeader: { name: 'x key', value: 's' } }),
  ).toThrow('A secret header needs a name')
  expect(() =>
    connectionInputOf({ name: 'CRM', url: 'https://crm.example/mcp', secretHeader: { name: 'x-key', value: '' } }),
  ).toThrow('A secret header needs a name')
})

test('a gateway name is the slug of the name with a random suffix and never contains "-"', () => {
  expect(gatewayNameOf('Sales CRM (EU)')).toMatch(/^salescrmeu_[0-9a-f]{6}$/)
  expect(gatewayNameOf('---')).toMatch(/^tools_[0-9a-f]{6}$/)
  expect(gatewayNameOf('CRM')).not.toBe(gatewayNameOf('CRM'))
})

test('a member gets the allowed tools, narrowed by their restriction', () => {
  expect(memberToolsOf(crm, [], bob)).toEqual(['lookup', 'update'])
  expect(
    memberToolsOf(crm, [{ connectionId: crm.id, memberId: bob, allowedTools: ['update', 'delete'] }], bob),
  ).toEqual(['update'])
  expect(memberToolsOf(crm, [{ connectionId: crm.id, memberId: bob, allowedTools: [] }], bob)).toEqual([])
})

test('only tools the server lists can be allowed, in the server’s order', () => {
  expect(knownToolsOf(crm, ['update', 'lookup'])).toEqual(['lookup', 'update'])
  expect(() => knownToolsOf(crm, ['drop'])).toThrow('CRM has no tool drop')
})

test('after a new listing, unticked tools stay unticked and new tools are allowed', () => {
  expect(
    allowedAfterRelisting(crm, [
      { name: 'lookup', readOnly: true },
      { name: 'delete', readOnly: false },
      { name: 'export', readOnly: true },
    ]),
  ).toEqual(['lookup', 'export'])
})
