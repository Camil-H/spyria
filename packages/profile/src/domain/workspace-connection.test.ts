import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@spyria/kernel'
import {
  allowedAfterRelisting,
  canSignIn,
  connectionInputOf,
  editedInputOf,
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
  signIn: 'shared',
  setupId: null,
  headerName: null,
  tools: [
    { name: 'lookup', readOnly: true },
    { name: 'update', readOnly: false },
    { name: 'delete', readOnly: false },
  ],
  allowedTools: ['lookup', 'update'],
}
const bob = memberId('member-bob')

const shared = { url: 'https://crm.example/mcp', signIn: 'shared' } as const

test('a server needs a name, an http address, a sign-in mode and, when a secret header is given, its name and value', () => {
  expect(connectionInputOf({ ...shared, name: ' CRM ' })).toEqual({ ...shared, name: 'CRM', secretHeader: undefined })
  expect(() => connectionInputOf({ ...shared, name: ' ' })).toThrow('A server needs a name')
  expect(() => connectionInputOf({ ...shared, name: 'CRM', url: 'ftp://crm.example' })).toThrow('http or https')
  expect(() => connectionInputOf({ ...shared, name: 'CRM', signIn: 'anyone' as never })).toThrow(
    'Choose whether each member signs in',
  )
  expect(() => connectionInputOf({ ...shared, name: 'CRM', secretHeader: { name: 'x key', value: 's' } })).toThrow(
    'A secret header needs a name',
  )
  expect(() => connectionInputOf({ ...shared, name: 'CRM', secretHeader: { name: 'x-key', value: '' } })).toThrow(
    'A secret header needs a name',
  )
})

test('a server each member signs in to takes no shared secret, and keeps its address once added', () => {
  const secretHeader = { name: 'x-key', value: 's' }
  expect(() => connectionInputOf({ ...shared, name: 'Docs', signIn: 'member', secretHeader })).toThrow(
    'takes no shared secret',
  )
  const docs = { ...crm, name: 'Docs', signIn: 'member' } as const
  expect(editedInputOf(docs, { name: 'Team docs', url: docs.url })).toMatchObject({
    name: 'Team docs',
    signIn: 'member',
  })
  expect(() => editedInputOf(docs, { name: 'Docs', url: 'https://docs.example/mcp' })).toThrow(
    'remove it and add it again',
  )
  expect(editedInputOf(crm, { name: 'CRM', url: 'https://crm2.example/mcp' })).toMatchObject({ signIn: 'shared' })
})

test('a member signs in only to a finished server they may use at least one tool of', () => {
  const docs = { ...crm, signIn: 'member' } as const
  expect(canSignIn(docs, [], bob)).toBe(true)
  expect(canSignIn(crm, [], bob)).toBe(false)
  expect(canSignIn({ ...docs, setupId: 'setup-1' }, [], bob)).toBe(false)
  expect(canSignIn(docs, [{ connectionId: crm.id, memberId: bob, allowedTools: [] }], bob)).toBe(false)
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
