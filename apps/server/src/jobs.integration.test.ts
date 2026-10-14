import { afterAll, expect, spyOn, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { jobs, sessions } from '@hq/db/postgres'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@hq/db/testing'
import type { SandboxProvider } from '@hq/runtime/server'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { listFailedJobs, maximumJobAttempts, retryFailedJobs, startJobWorker } from './job-worker.ts'
import { acme, alice, globex, bob, waitFor } from './testing.ts'

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

// Order matters: the jobs:failed and jobs:retry tests use the dead jobs left by the tests before them.
test('a throwing job is retried with a growing delay, then dead after 5 attempts with its last error', async () => {
  await addAgentPromptJob('job-broken', 'message-missing')
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
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
  expect(errorLog.mock.calls.filter(([message]) => String(message).includes('job-broken'))).toHaveLength(1)
  errorLog.mockRestore()
})

test('jobs:failed lists the dead jobs and jobs:retry requeues one, which then succeeds', async () => {
  await addDeadJob('job-dead-1', 'message-welcome-1')
  await addDeadJob('job-dead-2', 'message-welcome-2')
  expect((await listFailedJobs(database)).toSorted((first, second) => first.id.localeCompare(second.id))).toMatchObject(
    [
      { workspaceId: acme, id: 'job-broken', type: 'agent.prompt', attempts: 5, lastError: missingMessageError },
      { workspaceId: acme, id: 'job-dead-1', type: 'agent.prompt', attempts: 5, lastError: 'Earlier failure' },
      { workspaceId: acme, id: 'job-dead-2', type: 'agent.prompt', attempts: 5, lastError: 'Earlier failure' },
    ],
  )
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
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  const worker = startWorker({ retryDelayMilliseconds: 0 })
  await waitFor(
    async () => (await jobRow('job-dead-2'))?.state === 'done' && (await jobRow('job-broken'))?.state === 'failed',
  )
  await worker.stop()
  errorLog.mockRestore()
  expect(await jobRow('job-dead-2')).toMatchObject({ state: 'done', attempts: 1 })
  expect(await retryFailedJobs(database, 'job-unknown')).toEqual([])
})

test('the session sweep deletes only expired sessions, then reschedules itself once, a day later', async () => {
  await database.$client`
    insert into sessions (workspace_id, id, user_id, created_at, expires_at) values
      (${acme}, 'session-expired', ${alice}, now() - interval '8 days', now() - interval '1 day'),
      (${acme}, 'session-just-expired', ${bob}, now() - interval '7 days', now() - interval '1 second'),
      (${acme}, 'session-live', ${bob}, now(), now() + interval '7 days'),
      (${globex}, 'session-expired-in-globex', ${alice}, now() - interval '8 days', now() - interval '1 day'),
      (${globex}, 'session-live-in-globex', ${alice}, now(), now() + interval '1 hour')`
  await Promise.all([enqueueSweeps(database), enqueueSweeps(database)])
  for (const workspaceId of [acme, globex])
    expect(await sweepsOf(workspaceId)).toMatchObject([{ state: 'queued', attempts: 0, payload: {} }])

  const worker = startJobWorker(database, { pollIntervalMilliseconds: 5 })
  await waitFor(async () =>
    (await Promise.all([acme, globex].map(sweepsOf))).every((sweeps) => sweeps.some((job) => job.state === 'done')),
  )
  await sleep(100)
  await worker.stop()
  expect((await database.select().from(sessions)).map((session) => session.id).toSorted()).toEqual([
    'session-live',
    'session-live-in-globex',
  ])
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
