import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@spyria/kernel'
import {
  accessOf,
  canSignIn,
  connectionInputOf,
  editedInputOf,
  gatewayNameOf,
  markedToolsOf,
  relistedToolsOf,
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
    { name: 'lookup', readOnly: true, destructive: false },
    { name: 'update', readOnly: false, destructive: false },
    { name: 'delete', readOnly: false, destructive: true },
  ],
  isReviewed: true,
}
const bob = memberId('member-bob')
const bobAsMember = { memberId: bob, roleId: 'member' }
const memberRoleReads = {
  connectionId: crm.id,
  roleId: 'member',
  memberId: null,
  level: 'read',
  toolChanges: {},
} as const

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

test('a member signs in only to a finished, reviewed server they may use at least one tool of', () => {
  const docs = { ...crm, signIn: 'member' } as const
  expect(canSignIn(docs, [memberRoleReads], bobAsMember)).toBe(true)
  expect(canSignIn(crm, [memberRoleReads], bobAsMember)).toBe(false)
  expect(canSignIn({ ...docs, setupId: 'setup-1' }, [memberRoleReads], bobAsMember)).toBe(false)
  expect(canSignIn({ ...docs, isReviewed: false }, [memberRoleReads], bobAsMember)).toBe(false)
  expect(canSignIn(docs, [], bobAsMember)).toBe(false)
})

test('a gateway name is the slug of the name with a random suffix and never contains "-"', () => {
  expect(gatewayNameOf('Sales CRM (EU)')).toMatch(/^salescrmeu_[0-9a-f]{6}$/)
  expect(gatewayNameOf('---')).toMatch(/^tools_[0-9a-f]{6}$/)
  expect(gatewayNameOf('CRM')).not.toBe(gatewayNameOf('CRM'))
})

test('access keeps only the single changes that differ from its level, on tools the server lists', () => {
  expect(
    accessOf(crm, { roleId: 'member', level: 'read', toolChanges: { lookup: true, update: true, delete: false } }),
  ).toEqual({ ...memberRoleReads, toolChanges: { update: true } })
  expect(accessOf(crm, { memberId: bob, level: 'none', toolChanges: {} })).toMatchObject({
    roleId: null,
    memberId: bob,
  })
  expect(accessOf(crm, { memberId: bob, level: null, toolChanges: {} })).toBeNull()
  expect(() => accessOf(crm, { roleId: 'member', level: 'read', toolChanges: { drop: true } })).toThrow(
    'CRM has no tool drop',
  )
  expect(() => accessOf(crm, { roleId: 'member', level: 'all' as never, toolChanges: {} })).toThrow('Choose None')
})

test('the admin corrects read and write markings only for tools the server lists', () => {
  expect(markedToolsOf(crm, [{ name: 'update', readOnly: true }]).map(({ readOnly }) => readOnly)).toEqual([
    true,
    true,
    false,
  ])
  expect(() => markedToolsOf(crm, [{ name: 'drop', readOnly: true }])).toThrow('CRM has no tool drop')
})

test('after a new listing, known tools keep their marking and new tools count as writes', () => {
  expect(
    relistedToolsOf(crm, [
      { name: 'lookup', readOnly: false, destructive: false },
      { name: 'export', readOnly: true, destructive: false },
    ]),
  ).toEqual([
    { name: 'lookup', readOnly: true, destructive: false },
    { name: 'export', readOnly: false, destructive: false },
  ])
})
