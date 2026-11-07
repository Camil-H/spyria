import { expect, test } from 'bun:test'
import { workspacePermissions } from '@spyria/kernel'
import { alice, failedWith, openSharedTestApp, succeeded } from './testing/testing.ts'

const { database, resultOf } = await openSharedTestApp()

const addSsoWorkspace = async (workspaceId: string, joinBy: 'domain' | 'invited_address') => {
  await database.$client.begin(async (sql) => {
    await sql`
      insert into workspaces (workspace_id, name, created_by, join_by, created_at)
      values (${workspaceId}, ${workspaceId}, ${alice}, ${joinBy}, now())`
    await sql`
      insert into workspace_roles (workspace_id, id, name, built_in)
      values (${workspaceId}, 'admin', 'Admin', true), (${workspaceId}, 'member', 'Member', true)`
    await sql`
      insert into workspace_role_permissions (workspace_id, role_id, permission)
      select ${workspaceId}, 'admin', unnest(${sql.array([...workspacePermissions])}::text[])`
    await sql`
      insert into memberships (workspace_id, user_id, role, display_name) values (${workspaceId}, ${alice}, 'admin', 'Alice')`
    await sql`
      insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
      values (${workspaceId}, 'oidc', 'https://idp.join-by.test', 'spyria', 'sealed', now())`
    if (joinBy === 'domain')
      await sql`insert into sso_domains (workspace_id, domain) values (${workspaceId}, 'join-by.test')`
  })
  return { workspaceId, userId: alice }
}
const invite = (admin: { workspaceId: string; userId: string }, email: string) =>
  resultOf(admin, 'workspace.inviteMember', {
    workspaceId: admin.workspaceId,
    id: crypto.randomUUID(),
    email,
    role: 'member',
  })

test('a workspace joined by invited address invites at once, while one joined by email domain waits for its domain to be verified', async () => {
  const invited = await addSsoWorkspace(`invited-${crypto.randomUUID()}`, 'invited_address')
  expect(await invite(invited, 'bob@gmail.com')).toEqual(succeeded)
  const byDomain = await addSsoWorkspace(`domain-${crypto.randomUUID()}`, 'domain')
  expect(await invite(byDomain, 'bob@join-by.test')).toEqual(
    failedWith(
      'Invites open once an email domain of this workspace is verified: send the verification link from the Sign-in settings',
    ),
  )
})

test('a new workspace created from one joined by invited address reuses its provider and its setting, without a domain', async () => {
  const invited = await addSsoWorkspace(`invited-${crypto.randomUUID()}`, 'invited_address')
  const newWorkspaceId = crypto.randomUUID()
  expect(
    await resultOf(invited, 'workspace.createWorkspace', {
      workspaceId: invited.workspaceId,
      id: newWorkspaceId,
      name: 'Side project',
    }),
  ).toEqual(succeeded)
  expect([
    ...(await database.$client`
      select join_by, issuer from workspaces join workspace_sso using (workspace_id) where workspace_id = ${newWorkspaceId}`),
  ]).toEqual([{ join_by: 'invited_address', issuer: 'https://idp.join-by.test' }])
  expect(await database.$client`select 1 from sso_domains where workspace_id = ${newWorkspaceId}`).toHaveLength(0)
  expect(await invite({ workspaceId: newWorkspaceId, userId: alice }, 'carol@gmail.com')).toEqual(succeeded)
})
