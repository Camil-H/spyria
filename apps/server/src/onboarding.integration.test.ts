import { beforeEach, expect, test } from 'bun:test'
import { createZeroStore } from '@spyria/db/zero-store'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  globex,
  openSharedTestApp,
  openZeroStore,
  succeeded,
  waitFor,
} from './testing/testing.ts'

const { database, resultOf } = await openSharedTestApp()

beforeEach(async () => {
  await database.$client`delete from workspace_onboarding`
  await database.$client`delete from member_onboarding`
  await database.$client`delete from github_apps`
  await database.$client`delete from github_connections`
})

const connectGitHubApp = () => database.$client`
  insert into github_apps (workspace_id, app_id, client_id, encrypted_client_secret, encrypted_private_key,
    encrypted_webhook_secret, updated_at)
  values (${acme}, '1', 'client', 'secret', 'key', 'webhook', now())`
const linkGitHubAccount = (userId: string) => database.$client`
  insert into github_connections (workspace_id, user_id, login, encrypted_access_token, updated_at)
  values (${acme}, ${userId}, 'login', 'sealed', now())`
const workspaceTasks = async () =>
  (
    await database.$client<{ task: string }[]>`
    select task from workspace_onboarding where workspace_id = ${acme} order by task`
  ).map(({ task }) => task)
const memberRows = async (userId: string) =>
  (
    await database.$client<{ task: string; completed_at: Date | null; skipped_at: Date | null }[]>`
      select task, completed_at, skipped_at from member_onboarding
      where workspace_id = ${acme} and user_id = ${userId} order by task`
  ).map(({ task, completed_at, skipped_at }) => ({
    task,
    isCompleted: completed_at !== null,
    isSkipped: skipped_at !== null,
  }))
const record = (member: typeof aliceInAcme) =>
  resultOf(member, 'onboarding.recordCompletedTasks', { workspaceId: member.workspaceId })

test('recording keeps only the tasks whose condition holds, and workspace tasks only for members holding their permission', async () => {
  await connectGitHubApp()
  await linkGitHubAccount(bob)
  expect(await record(bobInAcme)).toEqual(succeeded)
  expect(await workspaceTasks()).toEqual([])
  expect(await memberRows(bob)).toEqual([{ task: 'link-github-account', isCompleted: true, isSkipped: false }])
  expect(await record(aliceInAcme)).toEqual(succeeded)
  expect(await workspaceTasks()).toEqual(['connect-github-app', 'invite-members'])
  expect((await memberRows(alice)).map(({ task }) => task)).not.toContain('link-github-account')
})

test('a recorded task stays recorded after its condition goes back', async () => {
  await connectGitHubApp()
  await record(aliceInAcme)
  await database.$client`delete from github_apps`
  expect(await record(aliceInAcme)).toEqual(succeeded)
  expect(await workspaceTasks()).toContain('connect-github-app')
})

test('a member skips and restores a task for themselves only, and an unknown task is refused', async () => {
  const skip = { workspaceId: acme, task: 'connect-runtime' }
  expect(await resultOf(bobInAcme, 'onboarding.skipTask', skip)).toEqual(succeeded)
  expect(await memberRows(bob)).toEqual([{ task: 'connect-runtime', isCompleted: false, isSkipped: true }])
  expect(await memberRows(alice)).toEqual([])
  expect(await resultOf(bobInAcme, 'onboarding.restoreTask', skip)).toEqual(succeeded)
  expect(await memberRows(bob)).toEqual([{ task: 'connect-runtime', isCompleted: false, isSkipped: false }])
  expect(await resultOf(bobInAcme, 'onboarding.skipTask', { workspaceId: acme, task: 'drop-tables' })).toEqual(
    expect.objectContaining({ error: expect.any(String) }),
  )
  expect(await resultOf(bobInAcme, 'onboarding.skipTask', { ...skip, workspaceId: globex })).toEqual(
    expect.objectContaining({ error: expect.any(String) }),
  )
  expect(await memberRows(bob)).toEqual([{ task: 'connect-runtime', isCompleted: false, isSkipped: false }])
})

test('a member’s checklist rows and GitHub link reach only their replica, workspace records and the GitHub App reach every member', async () => {
  await connectGitHubApp()
  await linkGitHubAccount(bob)
  await resultOf(bobInAcme, 'onboarding.skipTask', { workspaceId: acme, task: 'add-ai-key' })
  await record(aliceInAcme)
  const aliceStore = await openZeroStore(createZeroStore, alice, [acme])
  const bobStore = await openZeroStore(createZeroStore, bob, [acme])
  await waitFor(() => bobStore.read().memberOnboarding.length > 0 && bobStore.read().workspaceOnboarding.length > 0)
  await waitFor(() => aliceStore.read().workspaceOnboarding.length > 0)
  expect(aliceStore.read().memberOnboarding.map(({ memberId }) => memberId)).not.toContain(bob)
  expect(aliceStore.read().githubConnections).toEqual([])
  expect(bobStore.read().githubConnections).toEqual([{ workspaceId: acme, memberId: bob }])
  expect(bobStore.read().githubApps).toEqual([{ workspaceId: acme }])
  expect(
    bobStore
      .read()
      .workspaceOnboarding.map(({ task }) => task)
      .toSorted(),
  ).toEqual(['connect-github-app', 'invite-members'])
})
