import { expect, setDefaultTimeout, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createDatabase } from '@spyria/db/postgres'
import { databaseUrlOf, testGatewayAdmin } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { type WorkspaceId, workspaceId } from '@spyria/kernel'
import { createBifrostUsageLogs, createUsageJobs, syncUsageNow } from '@spyria/usage/server'
import {
  acme,
  alice,
  bob,
  captureLogs,
  gatewayLogsOf,
  globex,
  openSharedTestApp,
  rejectionOf,
  virtualKeyOf,
} from './testing/testing.ts'

setDefaultTimeout(60_000)
const { database, gateway } = await openSharedTestApp()
const gatewayAdmin = { adminUser: testGatewayAdmin.user, adminPassword: testGatewayAdmin.password }
const zeroDatabase = zeroDrizzle(schema, database)
const transact = <Result>(work: Parameters<typeof zeroDatabase.transaction<Result>>[0]) =>
  zeroDatabase.transaction(work)

const run = crypto.randomUUID()
const logs = createBifrostUsageLogs({ url: gateway.url, ...gatewayAdmin, labels: { run } })
const sync = (workspace: WorkspaceId = acme) => syncUsageNow(logs, { workspaceId: workspace, transact })

const aliceKey = await virtualKeyOf(alice)
let callsMade = 0
const modelCall = async (labels: Record<string, string>, model = 'mistral/codestral-latest') => {
  callsMade++
  await fetch(`${gateway.url}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${aliceKey.value}`,
      'content-type': 'application/json',
      ...Object.fromEntries(Object.entries({ ...labels, run }).map(([name, value]) => [`x-bf-dim-${name}`, value])),
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
}
const landed = () => gatewayLogsOf(gateway, `metadata_run=${run}`, callsMade)
const research = { workspace: acme, chat: 'chat-research', owner: alice }
const usageRows = async () =>
  database.$client`
    select workspace_id, month, chat_id, user_id, model, tokens, cost_micros::int, calls from usage_entries
    where chat_id <> 'chat-invoice-bug' order by chat_id, user_id, model`
const modelCallsOf = async (prompter: string) =>
  database.$client`select chat_id, owner_id, model, provider, input_tokens, output_tokens, cost_micros, status
    from model_calls where prompter_id = ${prompter} order by called_at`
const month = new Date().toISOString().slice(0, 7)

test('the sync records each gateway call once across overlapping windows and reruns, by the labels of the call', async () => {
  await modelCall({ ...research, prompter: alice })
  await modelCall({ ...research, prompter: alice })
  await modelCall({ ...research, prompter: bob, turn: 'turn-bob', session: 'session-bob' })
  await landed()
  await sync()
  await sync()
  const aliceRow = {
    workspace_id: acme,
    month,
    chat_id: 'chat-research',
    user_id: alice,
    model: 'mistral/codestral-latest',
  }
  const bobRow = { ...aliceRow, user_id: bob, tokens: 2, cost_micros: 18, calls: 1 }
  const afterTwoCalls = [{ ...aliceRow, tokens: 4, cost_micros: 36, calls: 2 }, bobRow]
  expect([...(await usageRows())]).toEqual(afterTwoCalls)
  expect([...(await modelCallsOf(bob))]).toEqual([
    {
      chat_id: 'chat-research',
      owner_id: alice,
      model: 'codestral-latest',
      provider: 'mistral',
      input_tokens: 1,
      output_tokens: 1,
      cost_micros: 18,
      status: 'success',
    },
  ])
  expect([...(await database.$client`select turn_id, session_id from model_calls where prompter_id = ${bob}`)]).toEqual(
    [{ turn_id: 'turn-bob', session_id: 'session-bob' }],
  )
  expect([
    ...(await database.$client`select distinct turn_id, session_id from model_calls where prompter_id = ${alice}`),
  ]).toEqual([{ turn_id: null, session_id: null }])

  await database.$client`update usage_sync_marks set logs_since = now() - interval '1 hour' where workspace_id = ${acme}`
  await modelCall({ ...research, prompter: alice })
  await modelCall({ ...research, prompter: alice }, 'mistral/mistral-small-latest')
  await landed()
  await sync()
  expect([...(await usageRows())]).toEqual([
    { ...aliceRow, tokens: 6, cost_micros: 54, calls: 3 },
    { ...aliceRow, model: 'mistral/mistral-small-latest', tokens: 2, cost_micros: 12, calls: 1 },
    bobRow,
  ])
})

test('failed provider calls count as calls with zero tokens, logs of other workspaces are ignored', async () => {
  await modelCall({ workspace: acme, chat: 'chat-welcome', owner: alice, prompter: alice }, 'openai/gpt-4o')
  await modelCall({ workspace: globex, chat: 'chat-launch-plan', owner: alice, prompter: alice })
  await landed()
  await sync()
  const welcome = await database.$client`
    select tokens, cost_micros::int, calls from usage_entries where chat_id = 'chat-welcome'`
  expect([...welcome]).toEqual([{ tokens: 0, cost_micros: 0, calls: 1 }])
  expect([...(await database.$client`select status from model_calls where chat_id = 'chat-welcome'`)]).toEqual([
    { status: 'error' },
  ])
  expect([...(await database.$client`select 1 from usage_entries where workspace_id = ${globex}`)]).toEqual([])
  expect([...(await database.$client`select 1 from model_calls where workspace_id = ${globex}`)]).toEqual([])
})

test('with the gateway down the sync changes nothing and the job reschedules itself', async () => {
  const before = {
    usage: [...(await usageRows())],
    mark: [...(await database.$client`select * from usage_sync_marks`)],
  }
  const downLogs = createBifrostUsageLogs({ url: 'http://127.0.0.1:9', ...gatewayAdmin })
  await rejectionOf(syncUsageNow(downLogs, { workspaceId: acme, transact }))
  const job = createUsageJobs(downLogs)['usage.sync']
  const logged = captureLogs()
  await job?.({ workspaceId: workspaceId(acme), transact })
  await job?.({ workspaceId: workspaceId(acme), transact })
  logged.restore()
  expect(logged.events.map(({ severity, event }) => [severity, event])).toEqual([
    ['ERROR', 'usage.sync_failed'],
    ['ERROR', 'usage.sync_failed'],
  ])
  expect({
    usage: [...(await usageRows())],
    mark: [...(await database.$client`select * from usage_sync_marks`)],
  }).toEqual(before)
  expect([
    ...(await database.$client`select state from jobs where workspace_id = ${acme} and type = 'usage.sync'`),
  ]).toEqual([{ state: 'queued' }])
})

test('the sync pages through the gateway logs by time and records every call once', async () => {
  const pagesFrom: Date[] = []
  const pagedLogs = createBifrostUsageLogs({ url: gateway.url, ...gatewayAdmin, labels: { run }, pageSize: 2 })
  const countedLogs = {
    since: (workspace: WorkspaceId, since: Date) => {
      pagesFrom.push(since)
      return pagedLogs.since(workspace, since)
    },
  }
  for (const turn of ['turn-paged-1', 'turn-paged-2', 'turn-paged-3'])
    await modelCall({ ...research, prompter: alice, turn })
  await landed()
  const gatewayLogs = createDatabase(databaseUrlOf('spyria_test_gateway_integration'))
  const pagedLogIds = gatewayLogs.$client`
    select id from logs where metadata::jsonb ->> 'run' = ${run} and metadata::jsonb ->> 'turn' like 'turn-paged-%'`
  const sameMillisecond = await gatewayLogs.$client`
    update logs set timestamp = (select min(timestamp) from logs where id in (${pagedLogIds}))
    where id in (${pagedLogIds})`
  await gatewayLogs.$client.end()
  expect(sameMillisecond.count).toBe(3)
  await syncUsageNow(countedLogs, { workspaceId: acme, transact })
  expect(pagesFrom.length).toBeGreaterThan(1)
  expect([
    ...(await database.$client`
      select turn_id, count(*)::int as calls from model_calls where turn_id like 'turn-paged-%'
      group by turn_id order by turn_id`),
  ]).toEqual([
    { turn_id: 'turn-paged-1', calls: 1 },
    { turn_id: 'turn-paged-2', calls: 1 },
    { turn_id: 'turn-paged-3', calls: 1 },
  ])
})

test('a first sync reads a bounded number of pages, keeps each one, and a call pending past the hold no longer pins the window', async () => {
  const markOf = async () => {
    const [mark] = await database.$client<{ logs_since: string }[]>`
      select logs_since from usage_sync_marks where workspace_id = ${globex}`
    return mark && new Date(mark.logs_since)
  }
  await database.$client`delete from usage_sync_marks where workspace_id = ${globex}`
  const pagesFrom: Date[] = []
  const endlessLogs = {
    since: async (_: WorkspaceId, since: Date) => {
      pagesFrom.push(since)
      return { calls: [], nextPageFrom: new Date(since.getTime() + 60_000) }
    },
  }
  const startedAt = Date.now()
  const logged = captureLogs()
  await syncUsageNow(endlessLogs, { workspaceId: workspaceId(globex), transact })
  logged.restore()
  expect(pagesFrom.length).toBe(20)
  expect(Math.abs(startedAt - 30 * 24 * 3_600_000 - (pagesFrom[0]?.getTime() ?? 0))).toBeLessThan(5_000)
  expect((await markOf())?.getTime()).toBe((pagesFrom.at(-1)?.getTime() ?? 0) + 60_000)
  expect(logged.events.map(({ event }) => event)).toEqual(['usage.sync_behind'])

  const mark = await markOf()
  pagesFrom.length = 0
  const secondRun = captureLogs()
  await syncUsageNow(endlessLogs, { workspaceId: workspaceId(globex), transact })
  secondRun.restore()
  expect(pagesFrom[0]).toEqual(mark)

  await database.$client`update usage_sync_marks set logs_since = now() - interval '2 hours' where workspace_id = ${globex}`
  const stuckLogs = {
    since: async () => ({ calls: [], oldestPendingAt: new Date(Date.now() - 2 * 3_600_000 + 1_000) }),
  }
  await syncUsageNow(stuckLogs, { workspaceId: workspaceId(globex), transact })
  const heldMinutes = (Date.now() - ((await markOf())?.getTime() ?? 0)) / 60_000
  expect(heldMinutes).toBeGreaterThanOrEqual(30)
  expect(heldMinutes).toBeLessThan(31)
})
