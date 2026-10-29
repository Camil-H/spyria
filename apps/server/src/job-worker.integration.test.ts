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
    expect((await jobRow('job-broken'))?.finishedAt?.getTime()).toBeGreaterThan(startedAt)
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
    expect(await jobRow('job-dead-1')).toMatchObject({ state: 'queued', attempts: 0, finishedAt: null })
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

describe('a job longer than its lease', () => {
  test('keeps its lease while it runs, so a second worker never claims it again', async () => {
    let removals = 0
    const sandboxProvider = {
      remove: async () => {
        removals++
        await sleep(400)
      },
    } as unknown as SandboxProvider
    await addAgentPromptJob('job-long', 'unused', {
      type: 'runtime.discard',
      payload: { runtimeId: 'runtime-long', hostId: 'host-long' },
    })
    const workers = [1, 2].map(() => startWorker({ sandboxProvider, leaseMilliseconds: 90 }))
    await waitFor(async () => (await jobRow('job-long'))?.state === 'done')
    await Promise.all(workers.map((worker) => worker.stop()))
    expect(removals).toBe(1)
    expect(await jobRow('job-long')).toMatchObject({ state: 'done', attempts: 1 })
    expect((await jobRow('job-long'))?.finishedAt).toBeInstanceOf(Date)
  })
})

test('a queued job wakes an idle worker at once instead of waiting for its next poll', async () => {
  const sandboxProvider = { remove: async () => {} } as unknown as SandboxProvider
  const worker = startWorker({ sandboxProvider, pollIntervalMilliseconds: 60_000 })
  await sleep(200)
  await addAgentPromptJob('job-woken', 'unused', {
    type: 'runtime.discard',
    payload: { runtimeId: 'runtime-woken', hostId: 'host-woken' },
  })
  await waitFor(async () => (await jobRow('job-woken'))?.state === 'done', 2_000)
  await worker.stop()
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
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state, finished_at) values
      (${acme}, 'job-done-old', 'agent.prompt', '{}', now() - interval '26 hours', 1, 'done', now() - interval '25 hours'),
      (${acme}, 'job-done-recent', 'agent.prompt', '{}', now() - interval '26 hours', 1, 'done', now() - interval '23 hours'),
      (${acme}, 'job-failed-old', 'agent.prompt', '{}', now() - interval '26 hours', 5, 'failed', now() - interval '25 hours'),
      (${globex}, 'job-done-old-in-globex', 'agent.prompt', '{}', now() - interval '26 hours', 1, 'done', now() - interval '25 hours')`
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

test('jobs:retry drops a dead sweep whose workspace already has one queued, and a sweep that failed within the hour is not scheduled again', async () => {
  const jobsOf = async (workspaceId: string, type: string) =>
    (await database.select().from(jobs)).filter((job) => job.workspaceId === workspaceId && job.type === type)
  await database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state, finished_at) values
      (${acme}, 'job-dead-session-sweep', 'sessions.sweep', '{}', now(), 5, 'failed', now())`
  expect(await retryFailedJobs(database, 'job-dead-session-sweep')).toEqual(['job-dead-session-sweep'])
  expect(await jobRow('job-dead-session-sweep')).toBeUndefined()
  expect((await jobsOf(acme, 'sessions.sweep')).filter((job) => job.state === 'queued')).toHaveLength(1)

  await database.$client`delete from jobs where workspace_id = ${globex} and type = 'runtime.sweep'`
  await database.$client`
    insert into jobs (workspace_id, id, type, payload, run_at, attempts, state, finished_at) values
      (${globex}, 'job-dead-runtime-sweep', 'runtime.sweep', '{}', now(), 5, 'failed', now())`
  await enqueueSweeps(database)
  expect((await jobsOf(globex, 'runtime.sweep')).map((job) => job.id)).toEqual(['job-dead-runtime-sweep'])

  await database.$client`
    update jobs set finished_at = now() - interval '2 hours' where id = 'job-dead-runtime-sweep'`
  await enqueueSweeps(database)
  expect((await jobsOf(globex, 'runtime.sweep')).map((job) => job.state).toSorted()).toEqual(['failed', 'queued'])
  expect(await retryFailedJobs(database, 'job-dead-runtime-sweep')).toEqual(['job-dead-runtime-sweep'])
  expect((await jobsOf(globex, 'runtime.sweep')).map((job) => job.state)).toEqual(['queued'])
})
