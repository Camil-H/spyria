import { afterAll, describe, expect, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { jobs, sessions } from '@spyria/db/postgres'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import type { SandboxProvider } from '@spyria/runtime/server'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { listFailedJobs, maximumJobAttempts, retryFailedJobs, startJobWorker } from './job-worker.ts'
import { acme, alice, bob, captureLogs, globex, waitFor } from './testing/testing.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
afterAll(() => testDatabase.drop(), databaseDropTimeoutMilliseconds)

const missingMessageError = 'Message message-missing was not found'
const agentBridge = createAgentBridge({
  sandboxProvider: {} as SandboxProvider,
  llm: { model: 'openai/fake' },
})
const startWorker = (options: Parameters<typeof startJobWorker>[1] = {}) =>
  startJobWorker(database, { pollIntervalMilliseconds: 5, ...options, agentBridge })

const jobRow = async (id: string) => (await database.select().from(jobs)).find((job) => job.id === id)
const sweepsOf = async (workspaceId: string) =>
  (await database.select().from(jobs)).filter((job) => job.type === 'sessions.sweep' && job.workspaceId === workspaceId)
const addAgentPromptJob = (id: string, promptId: string, fields: Partial<typeof jobs.$inferInsert> = {}) =>
  database.insert(jobs).values({
    workspaceId: acme,
    id,
    type: 'agent.prompt',
    payload: { messageId: promptId },
    runAt: new Date(),
    attempts: 0,
    state: 'queued',
    ...fields,
  })
const addDeadJob = (id: string, promptId: string) =>
  addAgentPromptJob(id, promptId, {
    attempts: maximumJobAttempts,
    state: 'failed',
    lastError: 'Earlier failure',
  })
const repliesTo = async (messageId: string) =>
  (await database.query.messages.findMany()).filter((message) => message.replyToId === messageId)

describe('the dead jobs left by a throwing job', () => {
  test('a throwing job is retried with a growing delay, then dead after 5 attempts with its last error', async () => {
    await addAgentPromptJob('job-broken', 'message-missing')
    const logged = captureLogs()
    const startedAt = Date.now()
    const worker = startWorker({ retryDelayMilliseconds: 60 })
    await waitFor(async () => ((await jobRow('job-broken'))?.attempts ?? 0) >= 1)
    expect(await jobRow('job-broken')).toMatchObject({ state: 'queued', lastError: missingMessageError })
    expect((await jobRow('job-broken'))?.runAt.getTime()).toBeGreaterThan(startedAt)
    await waitFor(async () => (await jobRow('job-broken'))?.state === 'failed')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60 * (1 + 2 + 3 + 4))
    await worker.stop()
    expect(await jobRow('job-broken')).toMatchObject({
      attempts: maximumJobAttempts,
      state: 'failed',
      lastError: missingMessageError,
    })
    logged.restore()
    const brokenJobErrors = logged.events.filter(
      ({ severity, attributes }) => severity === 'ERROR' && attributes?.['job.id'] === 'job-broken',
    )
    expect(brokenJobErrors).toHaveLength(1)
  })

  test('jobs:failed lists the dead jobs and jobs:retry requeues one, which then succeeds', async () => {
    await addDeadJob('job-dead-1', 'message-welcome-1')
    await addDeadJob('job-dead-2', 'message-welcome-2')
    expect(
      (await listFailedJobs(database)).toSorted((first, second) => first.id.localeCompare(second.id)),
    ).toMatchObject([
      { workspaceId: acme, id: 'job-broken', type: 'agent.prompt', attempts: 5, lastError: missingMessageError },
      { workspaceId: acme, id: 'job-dead-1', type: 'agent.prompt', attempts: 5, lastError: 'Earlier failure' },
      { workspaceId: acme, id: 'job-dead-2', type: 'agent.prompt', attempts: 5, lastError: 'Earlier failure' },
    ])
    expect((await listFailedJobs(database))[0]?.failedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)

    expect(await retryFailedJobs(database, 'job-dead-1')).toEqual(['job-dead-1'])
    expect(await jobRow('job-dead-1')).toMatchObject({ state: 'queued', attempts: 0 })
    expect(await jobRow('job-dead-2')).toMatchObject({ state: 'failed' })
    const worker = startWorker()
    await waitFor(async () => (await jobRow('job-dead-1'))?.state === 'done')
    await worker.stop()
    expect(await jobRow('job-dead-1')).toMatchObject({ state: 'done', attempts: 1 })
    expect(await repliesTo('message-welcome-1')).toEqual([])
    expect((await listFailedJobs(database)).map((job) => job.id).toSorted()).toEqual(['job-broken', 'job-dead-2'])
  })

  test('jobs:retry --all requeues every dead job', async () => {
    expect((await retryFailedJobs(database, 'all')).toSorted()).toEqual(['job-broken', 'job-dead-2'])
    expect(await jobRow('job-broken')).toMatchObject({ state: 'queued', attempts: 0 })
    const logged = captureLogs()
    const worker = startWorker({ retryDelayMilliseconds: 0 })
    await waitFor(
      async () => (await jobRow('job-dead-2'))?.state === 'done' && (await jobRow('job-broken'))?.state === 'failed',
    )
    await worker.stop()
    logged.restore()
    expect(await jobRow('job-dead-2')).toMatchObject({ state: 'done', attempts: 1 })
    expect(await retryFailedJobs(database, 'job-unknown')).toEqual([])
  })
})

test('the session sweep runs without a log line, deletes only expired sessions, done jobs older than a day and webhook deliveries older than a week, then reschedules itself once, a day later', async () => {
  await database.$client`
    insert into sessions (workspace_id, id, user_id, created_at, expires_at) values
      (${acme}, 'session-expired', ${alice}, now() - interval '8 days', now() - interval '1 day'),
      (${acme}, 'session-just-expired', ${bob}, now() - interval '7 days', now() - interval '1 second'),
      (${acme}, 'session-live', ${bob}, now(), now() + interval '7 days'),
      (${globex}, 'session-expired-in-globex', ${alice}, now() - interval '8 days', now() - interval '1 day'),
      (${globex}, 'session-live-in-globex', ${alice}, now(), now() + interval '1 hour')`
  await database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state) values
      (${acme}, 'job-done-old', 'agent.prompt', '{}', now() - interval '25 hours', 1, 'done'),
      (${acme}, 'job-done-recent', 'agent.prompt', '{}', now() - interval '23 hours', 1, 'done'),
      (${acme}, 'job-failed-old', 'agent.prompt', '{}', now() - interval '25 hours', 5, 'failed'),
      (${globex}, 'job-done-old-in-globex', 'agent.prompt', '{}', now() - interval '25 hours', 1, 'done')`
  await database.$client`
    insert into github_apps (workspace_id, app_id, client_id, encrypted_client_secret, encrypted_private_key,
      encrypted_webhook_secret, updated_at)
    values (${acme}, '1', 'client', 'secret', 'key', 'webhook', now())`
  await database.$client`
    insert into github_webhook_deliveries (workspace_id, delivery_id, received_at) values
      (${acme}, 'delivery-old', now() - interval '8 days'), (${acme}, 'delivery-recent', now() - interval '6 days')`
  await Promise.all([enqueueSweeps(database), enqueueSweeps(database)])
  for (const workspaceId of [acme, globex])
    expect(await sweepsOf(workspaceId)).toMatchObject([{ state: 'queued', attempts: 0, payload: {} }])

  const logged = captureLogs()
  const worker = startJobWorker(database, { pollIntervalMilliseconds: 5 })
  await waitFor(async () =>
    (await Promise.all([acme, globex].map(sweepsOf))).every((sweeps) => sweeps.some((job) => job.state === 'done')),
  )
  await sleep(100)
  await worker.stop()
  logged.restore()
  expect(logged.events.filter(({ event }) => event === 'job.run')).toEqual([])
  expect((await database.select().from(sessions)).map((session) => session.id).toSorted()).toEqual([
    'session-live',
    'session-live-in-globex',
  ])
  const keptJobIds = (await database.select().from(jobs)).map((job) => job.id)
  expect(keptJobIds).toEqual(expect.arrayContaining(['job-done-recent', 'job-failed-old']))
  expect(keptJobIds).not.toEqual(expect.arrayContaining(['job-done-old']))
  expect(keptJobIds).not.toEqual(expect.arrayContaining(['job-done-old-in-globex']))
  expect(
    (await database.$client`select delivery_id from github_webhook_deliveries`).map((row) => row.delivery_id),
  ).toEqual(['delivery-recent'])
  const oneDayLater = Date.now() + 24 * 60 * 60 * 1000
  for (const workspaceId of [acme, globex]) {
    const sweeps = await sweepsOf(workspaceId)
    expect(sweeps.map((job) => job.state).toSorted()).toEqual(['done', 'queued'])
    const nextSweep = sweeps.find((job) => job.state === 'queued')
    expect(Math.abs((nextSweep?.runAt.getTime() ?? 0) - oneDayLater)).toBeLessThan(60 * 1000)
  }

  await enqueueSweeps(database)
  for (const workspaceId of [acme, globex])
    expect((await sweepsOf(workspaceId)).filter((job) => job.state === 'queued')).toHaveLength(1)
})
