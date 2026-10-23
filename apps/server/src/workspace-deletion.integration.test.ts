import { afterAll, expect, test } from 'bun:test'
import { openSessions } from './auth/sessions.ts'
import { hasNoWorkspace } from './auth/sso.ts'
import { startJobWorker } from './job-worker.ts'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  failedWith,
  globex,
  issueTestSession,
  newChat,
  openSharedTestApp,
  rejectionOf,
  succeeded,
  virtualKeyOf,
  waitFor,
  workspaceEventsOf,
} from './testing/testing.ts'
import { abandonFailedCleanup, purgeWorkspaceNow, restoreWorkspace } from './workspace-deletion.ts'

const { database, app, gateway, llmGateway, resultOf } = await openSharedTestApp()
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 50,
  cleanupPollMilliseconds: 20,
  failedCleanupRetryMilliseconds: 50,
  llmGateway,
})
afterAll(() => worker.stop())

const aliceInGlobex = { workspaceId: globex, userId: alice }
const deleteAs = (member: { workspaceId: string; userId: string }, confirmation = 'DELETE') =>
  resultOf(member, 'workspace.deleteWorkspace', { workspaceId: member.workspaceId, confirmation })
const queryAs = (token: string) =>
  app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(['transform', [{ id: 'chats', name: 'chats', args: [] }]]),
  })
const workspaceOf = async (workspaceId: string) =>
  (
    await database.$client<{ isDeleted: boolean; purgeAt: number | null }[]>`
      select deleted_at is not null as "isDeleted", (extract(epoch from purge_at) * 1000)::float8 as "purgeAt"
      from workspaces where workspace_id = ${workspaceId}`
  )[0]
const purgeJobsOf = (workspaceId: string) =>
  database.$client<{ runAt: number }[]>`
    select (extract(epoch from run_at) * 1000)::float8 as "runAt" from jobs where workspace_id = ${workspaceId} and type = 'workspace.purge'`
const rowCountsOf = async (workspaceId: string) =>
  Object.fromEntries(
    await Promise.all(
      (
        await database.$client<{ table: string }[]>`
          select table_name as table from information_schema.columns
          where table_schema = current_schema() and column_name = 'workspace_id' order by table_name`
      ).map(async ({ table }) => {
        const [{ count = 0 } = {}] = await database.$client<{ count: number }[]>`
          select count(*)::int as count from ${database.$client(table)} where workspace_id = ${workspaceId}`
        return [table, count] as const
      }),
    ),
  )
const jobStateOf = async (workspaceId: string, id: string) =>
  (
    await database.$client<
      { state: string }[]
    >`select state from jobs where workspace_id = ${workspaceId} and id = ${id}`
  )[0]?.state
const sevenDaysMilliseconds = 7 * 24 * 60 * 60 * 1000

test('only an active Admin deletes the workspace, and only with DELETE typed', async () => {
  expect(await deleteAs(bobInAcme)).toEqual(failedWith('Only an Admin can delete this workspace'))
  expect(await deleteAs(aliceInAcme, 'delete')).not.toEqual(succeeded)
  expect((await workspaceOf(acme))?.isDeleted).toBe(false)
})

test('chat events stay append-only for a workspace that is not being purged, whatever the session settings', async () => {
  const refused = database.$client.begin(async (sql) => {
    await sql`select set_config('spyria.purging_workspace', ${acme}, true)`
    await sql`delete from events where workspace_id = ${acme}`
  })
  expect((await rejectionOf(refused)).message).toBe('events are append-only: DELETE rejected')
})

test('deleting a workspace ends its sessions, tokens and sign-ins at once, keeps its data for seven days, and the operator can restore it', async () => {
  try {
    const session = await issueTestSession(database, globex, alice)
    expect((await queryAs(session.token)).status).toBe(200)
    const deletedAt = Date.now()
    expect(await deleteAs(aliceInGlobex)).toEqual(succeeded)

    expect((await queryAs(session.token)).status).toBe(403)
    expect(await database.$client`select 1 from sessions where workspace_id = ${globex}`).toHaveLength(0)
    expect(await openSessions(database, alice, globex)).toHaveLength(0)
    expect((await openSessions(database, alice)).map(({ workspaceId }) => workspaceId)).toEqual([acme])
    const workspace = await workspaceOf(globex)
    expect(workspace?.isDeleted).toBe(true)
    expect((workspace?.purgeAt ?? 0) - deletedAt).toBeWithin(
      sevenDaysMilliseconds - 60_000,
      sevenDaysMilliseconds + 60_000,
    )
    const [purgeJob, ...otherPurgeJobs] = await purgeJobsOf(globex)
    expect(otherPurgeJobs).toEqual([])
    expect(Math.abs((purgeJob?.runAt ?? 0) - (workspace?.purgeAt ?? 0))).toBeLessThan(60_000)
    expect((await rowCountsOf(globex)).chats).toBeGreaterThan(0)
    await database.$client`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${globex}, 'sweep-while-deleted', 'sessions.sweep', '{}', now(), 0, 'queued')`
    await Bun.sleep(300)
    expect(await jobStateOf(globex, 'sweep-while-deleted')).toBe('queued')
    expect(
      (
        await database.$client`
      select type from jobs where workspace_id = ${globex} and state = 'queued' order by type`
      ).map(({ type }) => type),
    ).toEqual(['sessions.sweep', 'workspace.halt', 'workspace.purge'])
    expect(await workspaceEventsOf(database, globex)).toContainEqual({
      type: 'workspace.deleted',
      actorId: alice,
      payload: { purgeAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) },
    })

    await restoreWorkspace(database, globex)
    expect((await workspaceOf(globex))?.isDeleted).toBe(false)
    expect(await purgeJobsOf(globex)).toHaveLength(0)
    expect(await openSessions(database, alice, globex)).toHaveLength(1)
    expect((await workspaceEventsOf(database, globex)).map(({ type }) => type)).toContain('workspace.restored')
    await waitFor(async () => (await jobStateOf(globex, 'sweep-while-deleted')) !== 'queued')
    expect((await rejectionOf(restoreWorkspace(database, globex))).message).toBe(
      `Workspace ${globex} is not scheduled for deletion, or its purge has started`,
    )
  } finally {
    await database.$client`update workspaces set deleted_at = null, purge_at = null where workspace_id = ${globex}`
  }
})

test('the purge erases every row of the workspace with its chat history, gateway keys, shared connections and members who belong nowhere else, and leaves other workspaces untouched', async () => {
  await addLlmKey(bob, 'openai')
  const { id: virtualKeyId } = await virtualKeyOf(bob)
  await database.$client`
    insert into workspace_connections (workspace_id, id, name, gateway_name, url, tools, allowed_tools)
    values (${acme}, ${`connection-${crypto.randomUUID()}`}, 'CRM', ${`crm-${crypto.randomUUID()}`}, 'https://crm.example.com/mcp', '[]', '[]')`
  await newChat({ ownerId: alice, type: 'channel' })
  const globexRowsBefore = await rowCountsOf(globex)
  expect(await deleteAs(aliceInAcme)).toEqual(succeeded)
  await database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state, last_error)
    values (${acme}, 'removal-on-a-lost-host', 'runtime.remove', '{}', now(), 5, 'failed', 'Host offline')`

  await purgeWorkspaceNow(database, acme)
  await Bun.sleep(1000)
  expect((await workspaceOf(acme))?.isDeleted).toBe(true)
  expect([...(await abandonFailedCleanup(database, acme))]).toEqual([
    { type: 'runtime.remove', lastError: 'Host offline' },
  ])
  await waitFor(async () => (await workspaceOf(acme)) === undefined)

  expect(Object.entries(await rowCountsOf(acme)).filter(([, count]) => count > 0)).toEqual([])
  expect({ ...(await rowCountsOf(globex)), jobs: 0 }).toEqual({ ...globexRowsBefore, jobs: 0 })
  expect((await gateway.request(`/api/governance/virtual-keys/${virtualKeyId}`)).status).toBe(404)
  expect(
    (await database.$client`select id from users where id in (${alice}, ${bob}) order by id`).map(({ id }) => id),
  ).toEqual([alice])
})

test('once the last workspace of the instance is purged, its domain is free and a workspace can be created again', async () => {
  expect(await hasNoWorkspace(database.$client)).toBe(false)
  expect(await deleteAs(aliceInGlobex)).toEqual(succeeded)
  expect(await hasNoWorkspace(database.$client)).toBe(false)
  await purgeWorkspaceNow(database, globex)
  await waitFor(async () => (await workspaceOf(globex)) === undefined)
  expect(await hasNoWorkspace(database.$client)).toBe(true)
  expect(await database.$client`select 1 from sso_domains`).toHaveLength(0)
})
