import { beforeEach, expect, test } from 'bun:test'
import { createZeroStore } from '@hq/db/zero-store'
import {
  acme,
  alice,
  aliceInAcme,
  asMember,
  bob,
  bobInAcme,
  failedWith,
  lee,
  openSharedTestApp,
  openZeroStore,
  removeFromAcme,
  succeeded,
  waitFor,
  workspaceEventsOf,
} from './testing/testing.ts'

const { database, app, resultOf } = await openSharedTestApp()

const financeId = 'role-finance'
const managerId = 'role-manager'
const leeInAcme = { workspaceId: acme, userId: lee }
const refusedWithout = (permission: string) => failedWith(`Your workspace role does not allow this: ${permission}`)
const roleChange = (member: typeof aliceInAcme, name: string, args: Record<string, unknown>) =>
  resultOf(member, `workspace.${name}WorkspaceRole`, { workspaceId: acme, ...args })
const createRole = (id: string, name: string, permissions: string[], member = aliceInAcme) =>
  roleChange(member, 'create', { id, name, permissions })
const updateRole = (roleId: string, name: string, permissions: string[], member = aliceInAcme) =>
  roleChange(member, 'update', { roleId, name, permissions })
const deleteRole = (roleId: string, member = aliceInAcme) => roleChange(member, 'delete', { roleId })
const changeRole = (member: typeof aliceInAcme, memberId: string, role: string) =>
  resultOf(member, 'workspace.changeMemberRole', { workspaceId: acme, memberId, role })
const customRolesOf = async () => [
  ...(await database.$client`
    select role.id, role.name, coalesce(array_agg(granted.permission order by granted.permission)
      filter (where granted.permission is not null), '{}') as permissions
    from workspace_roles role
    left join workspace_role_permissions granted on granted.workspace_id = role.workspace_id and granted.role_id = role.id
    where role.workspace_id = ${acme} and not role.built_in group by role.id, role.name order by role.id`),
]
const inviteArgs = (email: string, role: string) => ({ workspaceId: acme, id: crypto.randomUUID(), email, role })
const roleOf = async (userId: string) =>
  (await database.$client`select role from memberships where workspace_id = ${acme} and user_id = ${userId}`)[0]?.role
const statusOf = async (userId: string, method: string, path: string) => (await asMember(userId, method, path)).status

beforeEach(async () => {
  await openSharedTestApp()
})

test('an admin creates, changes and deletes a workspace role, each recorded and audited under Roles', async () => {
  expect(await createRole(financeId, ' Finance ', ['budgets.manage', 'costs.view'])).toEqual(succeeded)
  expect(await customRolesOf()).toEqual([
    { id: financeId, name: 'Finance', permissions: ['budgets.manage', 'costs.view'] },
  ])
  expect(await updateRole(financeId, 'Accounting', ['costs.view', 'audit.view'])).toEqual(succeeded)
  expect(await customRolesOf()).toEqual([
    { id: financeId, name: 'Accounting', permissions: ['audit.view', 'costs.view'] },
  ])
  expect(await deleteRole(financeId)).toEqual(succeeded)
  expect(await customRolesOf()).toEqual([])
  expect((await workspaceEventsOf(database)).filter(({ type }) => type.startsWith('workspace_role.'))).toEqual([
    {
      type: 'workspace_role.created',
      actorId: alice,
      payload: { roleId: financeId, name: 'Finance', permissions: ['costs.view', 'budgets.manage'] },
    },
    {
      type: 'workspace_role.updated',
      actorId: alice,
      payload: { roleId: financeId, name: 'Accounting', permissions: ['costs.view', 'audit.view'] },
    },
    { type: 'workspace_role.deleted', actorId: alice, payload: { roleId: financeId, name: 'Accounting' } },
  ])
  const audit = JSON.parse((await asMember(alice, 'GET', '/api/audit-log?group=Roles')).body)
  expect(audit.entries.map(({ action, target }: Record<string, string>) => [action, target])).toEqual([
    ['Deleted a workspace role', 'Accounting'],
    ['Changed a workspace role', 'Accounting'],
    ['Created a workspace role', 'Finance'],
  ])
})

test('names follow the role rules, Admin and Member are reserved and fixed, permissions are workspace ones, a Member manages no role', async () => {
  expect(await createRole(financeId, 'Finance', ['costs.view'])).toEqual(succeeded)
  expect(await createRole('role-copy', 'FINANCE', [])).toEqual(failedWith('A role named FINANCE already exists'))
  expect(await createRole('role-admin', 'admin', [])).toEqual(failedWith('admin is the name of a built-in role'))
  expect(await createRole('role-chat', 'Reader', ['chat.read'])).toEqual(
    failedWith('chat.read is not a workspace permission'),
  )
  for (const roleId of ['admin', 'member']) {
    expect(await updateRole(roleId, 'Renamed', [])).toEqual(
      failedWith(`${roleId} is not a custom role of this workspace`),
    )
    expect(await deleteRole(roleId)).toEqual(failedWith(`${roleId} is not a custom role of this workspace`))
  }
  for (const refused of [
    await createRole('role-bob', 'Mine', [], bobInAcme),
    await updateRole(financeId, 'Mine', [], bobInAcme),
    await deleteRole(financeId, bobInAcme),
  ])
    expect(refused).toEqual(refusedWithout('Manage roles'))
  expect(await customRolesOf()).toEqual([{ id: financeId, name: 'Finance', permissions: ['costs.view'] }])
})

test('Finance opens costs and budgets to Bob at once and nothing else', async () => {
  const settingsPaths = [
    ['GET', '/api/spend'],
    ['GET', '/api/budgets'],
    ['GET', '/api/audit-log'],
    ['GET', '/api/github-settings'],
    ['GET', '/api/sso-settings'],
  ] as const
  const statusesOf = () => Promise.all(settingsPaths.map(([method, path]) => statusOf(bob, method, path)))
  expect(await statusesOf()).toEqual([403, 403, 403, 403, 403])
  expect(await createRole(financeId, 'Finance', ['costs.view', 'budgets.manage'])).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, bob, financeId)).toEqual(succeeded)
  expect(await statusesOf()).toEqual([200, 200, 403, 403, 403])
  expect(await resultOf(bobInAcme, 'workspace.inviteMember', inviteArgs('nina@example.com', 'member'))).toEqual(
    refusedWithout('Invite members'),
  )
  expect(await changeRole(bobInAcme, lee, financeId)).toEqual(refusedWithout('Change roles and remove members'))
  expect(await updateRole(financeId, 'Finance', ['costs.view'])).toEqual(succeeded)
  expect(await statusesOf()).toEqual([200, 403, 403, 403, 403])
})

test('a manager changes roles and invites only within their own permissions, never an Admin nor themselves', async () => {
  expect(await createRole(managerId, 'Manager', ['members.invite', 'members.manage', 'costs.view'])).toEqual(succeeded)
  expect(await createRole(financeId, 'Finance', ['costs.view', 'budgets.manage'])).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, lee, managerId)).toEqual(succeeded)
  expect(await changeRole(leeInAcme, bob, managerId)).toEqual(succeeded)
  expect(await roleOf(bob)).toBe(managerId)
  expect(await changeRole(leeInAcme, bob, 'member')).toEqual(succeeded)
  expect(await changeRole(leeInAcme, bob, financeId)).toEqual(
    failedWith('Finance has permissions your own role does not have'),
  )
  expect(await changeRole(leeInAcme, bob, 'admin')).toEqual(
    failedWith('Admin has permissions your own role does not have'),
  )
  expect(await changeRole(leeInAcme, bob, 'role-gone')).toEqual(failedWith('role-gone is not a role of this workspace'))
  expect(await changeRole(leeInAcme, alice, 'member')).toEqual(
    failedWith('Admin has permissions your own role does not have'),
  )
  expect(await resultOf(leeInAcme, 'workspace.removeMember', { workspaceId: acme, memberId: alice })).toEqual(
    failedWith('Admin has permissions your own role does not have'),
  )
  expect(await changeRole(leeInAcme, lee, 'member')).toEqual(
    failedWith('You can neither change your own role nor remove yourself'),
  )
  expect(await resultOf(leeInAcme, 'workspace.inviteMember', inviteArgs('olga@example.com', 'admin'))).toEqual(
    failedWith('Admin has permissions your own role does not have'),
  )
  expect(await resultOf(leeInAcme, 'workspace.inviteMember', inviteArgs('olga@example.com', managerId))).toEqual(
    succeeded,
  )
  expect(await roleOf(alice)).toBe('admin')
})

test('a role manager cannot create or widen a role beyond their own permissions', async () => {
  expect(await createRole(managerId, 'Role keeper', ['roles.manage'])).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, bob, managerId)).toEqual(succeeded)
  expect(await createRole('role-wide', 'Wide', ['roles.manage', 'audit.view'], bobInAcme)).toEqual(
    failedWith('Wide has permissions your own role does not have'),
  )
  expect(await updateRole(managerId, 'Role keeper', ['roles.manage', 'members.manage'], bobInAcme)).toEqual(
    failedWith('Role keeper has permissions your own role does not have'),
  )
  expect(await createRole('role-narrow', 'Narrow', [], bobInAcme)).toEqual(succeeded)
})

test('the last Admin is never demoted; a second Admin demotes the first', async () => {
  expect(await createRole(managerId, 'Manager', ['members.manage'])).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, bob, managerId)).toEqual(succeeded)
  expect(await changeRole(bobInAcme, alice, 'member')).toEqual(
    failedWith('Admin has permissions your own role does not have'),
  )
  expect(await changeRole(aliceInAcme, lee, 'admin')).toEqual(succeeded)
  expect(await changeRole(leeInAcme, alice, 'member')).toEqual(succeeded)
  expect(await roleOf(alice)).toBe('member')
})

test('a held workspace role is not deleted, with members and pending invites counted; a removed holder goes back to Member', async () => {
  expect(await createRole(financeId, 'Finance', ['costs.view'])).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, bob, financeId)).toEqual(succeeded)
  expect(await changeRole(aliceInAcme, lee, financeId)).toEqual(succeeded)
  expect(await resultOf(aliceInAcme, 'workspace.inviteMember', inviteArgs('nina@example.com', financeId))).toEqual(
    succeeded,
  )
  expect(await deleteRole(financeId)).toEqual(
    failedWith('Finance is held by 2 members and 1 pending invite; change their role first'),
  )
  expect(await removeFromAcme(app, database, lee)).toEqual(succeeded)
  const [invitation] = await database.$client`select id from invitations where email = 'nina@example.com'`
  expect(
    await resultOf(aliceInAcme, 'workspace.revokeInvite', { workspaceId: acme, invitationId: invitation?.id }),
  ).toEqual(succeeded)
  expect(await deleteRole(financeId)).toEqual(failedWith('Finance is held by 1 member; change their role first'))
  expect(await changeRole(aliceInAcme, bob, 'member')).toEqual(succeeded)
  expect(await deleteRole(financeId)).toEqual(succeeded)
  expect(await roleOf(lee)).toBe('member')
  const audit = JSON.parse((await asMember(alice, 'GET', '/api/audit-log?group=Members')).body)
  expect(audit.entries.find(({ action }: { action: string }) => action === "Changed a member's role")).toMatchObject({
    target: 'Bob',
    details: expect.arrayContaining([{ label: 'Role', value: 'Member' }]),
  })
})

test('a custom role syncs what its permissions open and stops at once when they are taken away', async () => {
  expect(await createRole(managerId, 'Inviter', ['members.invite'])).toEqual(succeeded)
  expect(await resultOf(aliceInAcme, 'workspace.inviteMember', inviteArgs('nina@example.com', 'member'))).toEqual(
    succeeded,
  )
  const bobsAcme = await openZeroStore(createZeroStore, bob, [acme])
  expect(bobsAcme.read().invitations).toEqual([])
  expect(await changeRole(aliceInAcme, bob, managerId)).toEqual(succeeded)
  await waitFor(() => bobsAcme.read().invitations.some((invitation) => invitation.email === 'nina@example.com'))
  expect(bobsAcme.read().workspaceRoles.find((role) => role.id === managerId)?.permissions).toEqual(['members.invite'])
  expect(await updateRole(managerId, 'Inviter', [])).toEqual(succeeded)
  await waitFor(() => bobsAcme.read().invitations.length === 0)
})
