import { expect, test } from 'bun:test'
import { builtInChatRoles, builtInWorkspaceRoles } from '@spyria/kernel'
import {
  CustomRoleNotFound,
  InvalidRoleName,
  ReservedRoleName,
  RoleInUse,
  RoleNameTaken,
  RoleNotGrantable,
  UnknownChatPermission,
  UnknownWorkspacePermission,
  WorkspaceRoleNotFound,
} from './errors.ts'
import {
  customChatRoleOf,
  customWorkspaceRoleOf,
  requireCustomRole,
  requireGrantableRole,
  requireUnheldRole,
  requireUnheldWorkspaceRole,
  requireUniqueRoleName,
} from './role.ts'

const roleOrErrorOf = (name: string, permissions: readonly string[] = []) => {
  try {
    return customChatRoleOf({ id: 'role-reviewer', name, permissions })
  } catch (error) {
    return error
  }
}
const reviewer = { id: 'role-reviewer', name: 'Reviewer', permissions: ['chat.read' as const] }

test.each([
  ['  Reviewer  ', { ...reviewer }],
  ['R'.repeat(40), { ...reviewer, name: 'R'.repeat(40) }],
  ['   ', expect.any(InvalidRoleName)],
  ['R'.repeat(41), expect.any(InvalidRoleName)],
  ['owner', expect.any(ReservedRoleName)],
  [' READER ', expect.any(ReservedRoleName)],
])('the role name %p is trimmed or rejected', (name, expected) => {
  expect(roleOrErrorOf(name)).toEqual(expected)
})

test('the permissions always include chat.read, follow the kernel order without repeats and refuse unknown ones', () => {
  expect(roleOrErrorOf('Reviewer', ['session.configure', 'chat.post', 'session.configure'])).toEqual({
    ...reviewer,
    permissions: ['chat.read', 'chat.post', 'session.configure'],
  })
  expect(roleOrErrorOf('Reviewer', ['chat.read', 'chat.delete'])).toEqual(expect.any(UnknownChatPermission))
  expect((roleOrErrorOf('Reviewer', ['chat.delete']) as Error).message).toBe('chat.delete is not a chat permission')
})

test('a role name is unique per workspace whatever its case, the role itself aside', () => {
  const roles = [...builtInChatRoles, reviewer]
  expect(() => requireUniqueRoleName({ ...reviewer, id: 'role-other', name: 'reviewer' }, roles)).toThrow(RoleNameTaken)
  expect(() => requireUniqueRoleName({ ...reviewer, name: 'REVIEWER' }, roles)).not.toThrow()
})

test('only a stored custom role can change, and a held role cannot be deleted', () => {
  expect(() => requireCustomRole(undefined, 'role-gone')).toThrow(CustomRoleNotFound)
  expect(() => requireCustomRole({ ...reviewer, id: 'reader', builtIn: true }, 'reader')).toThrow(CustomRoleNotFound)
  expect(requireCustomRole({ ...reviewer, builtIn: false }, reviewer.id)).toEqual({ ...reviewer, builtIn: false })
  expect(() => requireUnheldRole(reviewer, { memberCount: 0, chatCount: 0 })).not.toThrow()
  expect(() => requireUnheldRole(reviewer, { memberCount: 1, chatCount: 1 })).toThrow(
    'Reviewer is held by 1 member in 1 chat; change their role first',
  )
  expect(() => requireUnheldRole(reviewer, { memberCount: 2, chatCount: 3 })).toThrow(RoleInUse)
  expect(() => requireUnheldRole(reviewer, { memberCount: 2, chatCount: 3 })).toThrow('held by 2 members in 3 chats')
})

const finance = { id: 'role-finance', name: 'Finance', permissions: ['costs.view' as const, 'budgets.manage' as const] }

test('a workspace role keeps the kernel order, may hold no permission and never takes a built-in name', () => {
  expect(customWorkspaceRoleOf({ ...finance, permissions: ['budgets.manage', 'costs.view', 'costs.view'] })).toEqual(
    finance,
  )
  expect(customWorkspaceRoleOf({ ...finance, permissions: [] })).toEqual({ ...finance, permissions: [] })
  expect(() => customWorkspaceRoleOf({ ...finance, name: ' admin ' })).toThrow(ReservedRoleName)
  expect(() => customWorkspaceRoleOf({ ...finance, permissions: ['chat.read'] })).toThrow(UnknownWorkspacePermission)
  expect(() => customWorkspaceRoleOf({ ...finance, permissions: ['chat.read'] })).toThrow(
    'chat.read is not a workspace permission',
  )
})

test('a workspace role is given only within the giver’s own permissions, and a held one is not deleted', () => {
  const [admin, member] = builtInWorkspaceRoles
  expect(requireGrantableRole(['costs.view', 'budgets.manage', 'members.manage'], finance, finance.id)).toBe(finance)
  expect(requireGrantableRole([], member, 'member')).toEqual({ id: 'member', name: 'Member', permissions: [] })
  expect(() => requireGrantableRole(['costs.view'], finance, finance.id)).toThrow(RoleNotGrantable)
  expect(() => requireGrantableRole(['costs.view', 'budgets.manage'], admin, 'admin')).toThrow(
    'Admin has permissions your own role does not have',
  )
  expect(() => requireGrantableRole(['costs.view'], undefined, 'role-gone')).toThrow(WorkspaceRoleNotFound)
  expect(() => requireUnheldWorkspaceRole(finance, { memberCount: 0, inviteCount: 0 })).not.toThrow()
  expect(() => requireUnheldWorkspaceRole(finance, { memberCount: 1, inviteCount: 0 })).toThrow(
    'Finance is held by 1 member; change their role first',
  )
  expect(() => requireUnheldWorkspaceRole(finance, { memberCount: 2, inviteCount: 1 })).toThrow(
    'Finance is held by 2 members and 1 pending invite; change their role first',
  )
})
