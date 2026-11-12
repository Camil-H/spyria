import { expect, test } from 'bun:test'
import { memberId } from './ids.ts'
import { approvalChoicesOf, grantedToolsOf, type ToolServerAccess, toolApprovalOf } from './tool-access.ts'

const bob = memberId('bob')
const lookup = { name: 'lookup', readOnly: true, destructive: false }
const update = { name: 'update', readOnly: false, destructive: false }
const purge = { name: 'purge', readOnly: false, destructive: true }
const crm = {
  id: 'crm',
  signIn: 'shared' as const,
  setupId: null,
  isReviewed: true,
  tools: [lookup, update, purge],
}
const accessOf = (access: Partial<ToolServerAccess>): ToolServerAccess => ({
  connectionId: 'crm',
  roleId: 'member',
  memberId: null,
  level: 'read',
  toolChanges: {},
  ...access,
})
const bobAsMember = { memberId: bob, roleId: 'member' }

test("a role's level grants its read tools, or all of them, and single changes add or remove one", () => {
  expect(grantedToolsOf(crm, [accessOf({ level: 'read' })], bobAsMember)).toEqual(['lookup'])
  expect(grantedToolsOf(crm, [accessOf({ level: 'write' })], bobAsMember)).toEqual(['lookup', 'update', 'purge'])
  expect(grantedToolsOf(crm, [accessOf({ level: 'none' })], bobAsMember)).toEqual([])
  expect(
    grantedToolsOf(crm, [accessOf({ level: 'read', toolChanges: { lookup: false, update: true } })], bobAsMember),
  ).toEqual(['update'])
})

test("a named member's access replaces their role's, and other roles grant nothing", () => {
  const rows = [accessOf({ level: 'write' }), accessOf({ roleId: null, memberId: bob, level: 'none' })]
  expect(grantedToolsOf(crm, rows, bobAsMember)).toEqual([])
  expect(grantedToolsOf(crm, rows, { memberId: memberId('lee'), roleId: 'member' })).toHaveLength(3)
  expect(grantedToolsOf(crm, rows, { memberId: memberId('lee'), roleId: 'admin' })).toEqual([])
})

test('a server grants nothing until its sign-in is done and its tools are reviewed', () => {
  const rows = [accessOf({ level: 'write' })]
  expect(grantedToolsOf({ ...crm, isReviewed: false }, rows, bobAsMember)).toEqual([])
  expect(grantedToolsOf({ ...crm, setupId: 'setup' }, rows, bobAsMember)).toEqual([])
})

test('approvals default to Always for destructive tools, Never for read tools and the server default for writes', () => {
  expect([lookup, update, purge].map((tool) => toolApprovalOf(crm, tool))).toEqual(['never', 'guest', 'always'])
  const member = { signIn: 'member' as const }
  expect(toolApprovalOf(member, update)).toBe('never')
  const preference = {
    connectionId: 'crm',
    serverApproval: 'always' as const,
    toolApprovals: { purge: 'never' as const },
  }
  expect([lookup, update, purge].map((tool) => toolApprovalOf(crm, tool, preference))).toEqual([
    'never',
    'always',
    'never',
  ])
})

test("only shared-login servers offer approval on a guest's prompt", () => {
  expect(approvalChoicesOf({ signIn: 'shared' })).toEqual(['never', 'always', 'guest'])
  expect(approvalChoicesOf({ signIn: 'member' })).toEqual(['never', 'always'])
})
