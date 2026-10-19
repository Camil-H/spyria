import { expect, test } from 'bun:test'
import { memberId } from './ids.ts'
import {
  builtInWorkspaceRoles,
  canGrantWorkspaceRole,
  MissingWorkspacePermission,
  requireWorkspacePermission,
  workspacePermissions,
} from './workspace-access.ts'

test('Admin holds every workspace permission and Member none', () => {
  expect(builtInWorkspaceRoles).toEqual([
    { id: 'admin', name: 'Admin', permissions: workspacePermissions },
    { id: 'member', name: 'Member', permissions: [] },
  ])
})

test('a role is grantable only when the granter holds all its permissions', () => {
  expect(canGrantWorkspaceRole(['costs.view', 'budgets.manage'], { permissions: ['costs.view'] })).toBe(true)
  expect(canGrantWorkspaceRole(['costs.view'], { permissions: ['costs.view', 'budgets.manage'] })).toBe(false)
  expect(canGrantWorkspaceRole([], { permissions: [] })).toBe(true)
})

test('requireWorkspacePermission returns the permissions or names the missing one in plain words', async () => {
  const members = { permissions: async () => ['costs.view' as const] }
  expect(await requireWorkspacePermission(members, memberId('member-bob'), 'costs.view')).toEqual(['costs.view'])
  const refusal = requireWorkspacePermission(members, memberId('member-bob'), 'budgets.manage')
  await expect(refusal).rejects.toBeInstanceOf(MissingWorkspacePermission)
  await expect(refusal).rejects.toMatchObject({
    code: 'missing_workspace_permission',
    message: 'Your workspace role does not allow this: Manage budgets',
  })
})
