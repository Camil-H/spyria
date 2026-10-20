import { expect, setDefaultTimeout, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { testGatewayAdmin } from '@spyria/db/testing'
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
    select workspace_id, month, chat_id, user_id, tokens, cost_micros::int, calls from usage_entries
    where chat_id <> 'chat-invoice-bug' order by chat_id, user_id`
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
  const aliceRow = { workspace_id: acme, month, chat_id: 'chat-research', user_id: alice }
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
  await landed()
  await sync()
  expect([...(await usageRows())]).toEqual([{ ...aliceRow, tokens: 6, cost_micros: 54, calls: 3 }, bobRow])
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
  await expect(syncUsageNow(downLogs, { workspaceId: acme, transact })).rejects.toThrow()
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
