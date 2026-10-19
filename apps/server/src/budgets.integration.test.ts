import { beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { schema } from '@hq/db/zero'
import { createZeroStore } from '@hq/db/zero-store'
import { syncUsageNow } from '@hq/usage/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import type { FakeLlmScript } from './fake-llm.ts'
import {
  acme,
  addLlmKey,
  alice,
  asMember,
  bob,
  type Launch,
  openZeroStore,
  runtimeTurn,
  startAgentStack,
  waitFor,
  workspaceEventsOf,
} from './testing/testing.ts'

setDefaultTimeout(40_000)
const { database, fakeLlmCalls, fakeHost, setFakeLlmScript, holds, prompt, turnOf, ...stack } = await startAgentStack({
  routing: true,
  resumeAfterMilliseconds: 5_000,
})
await addLlmKey(bob, 'Fake')
const lee = 'member-lee'
const zeroDatabase = zeroDrizzle(schema, database)
const sync = () =>
  syncUsageNow(
    { since: async () => ({ calls: [] }) },
    { workspaceId: acme, transact: (work) => zeroDatabase.transaction(work) },
  )
const memberNotice = "Bob's monthly AI budget is used up; an admin can raise it in Workspace settings"
const workspaceNotice = "The workspace's monthly AI budget is used up; an admin can raise it in Workspace settings"
const completion = JSON.stringify({ model: 'fake/fake-model', messages: [{ role: 'user', content: 'hi' }] })
const month = new Date().toISOString().slice(0, 7)

const spend = (prompterId: string, costMicros: number, calledAt = new Date()) =>
  database.$client`
    insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider, input_tokens,
      output_tokens, cost_micros, status, called_at)
    values (${acme}, ${`call-${crypto.randomUUID()}`}, 'chat-research', ${prompterId}, null, 'fake-model', 'fake', 1, 1,
      ${costMicros}, 'success', ${calledAt.toISOString()})`
const saveBudget = async (body: object, userId = alice) => {
  const answer = await asMember(userId, 'POST', '/api/budgets', body)
  return { status: answer.status, body: JSON.parse(answer.body) }
}
const ownBudgetOf = async (userId: string) => JSON.parse((await asMember(userId, 'GET', '/api/budgets/mine')).body)
const relayedCallOf = async (prompterId: string) => {
  const host = await fakeHost('Budget host')
  const { chatId, token } = await runtimeTurn(host, prompterId)
  const callsBefore = fakeLlmCalls.length
  const answer = await host.modelCall({
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: completion,
  })
  const [chat] = await database.$client`select agent_turn_failure from chats where id = ${chatId}`
  return { status: answer.status, reached: fakeLlmCalls.length - callsBefore, failure: chat?.agent_turn_failure }
}
const budgetEventsOf = async () =>
  (await workspaceEventsOf(database)).filter((event) => event.type.startsWith('budget.'))
const alertsOf = async () =>
  (
    await database.$client<{ id: string }[]>`
      select id from budget_alerts where workspace_id = ${acme} order by id`
  ).map((alert) => alert.id)

beforeEach(async () => {
  await database.$client`delete from budget_alerts`
  await database.$client`delete from budgets`
  await database.$client`delete from model_calls`
  await database.$client`delete from workspace_events where type like 'budget.%'`
})

test('members are refused the budgets and read only their own; a malformed budget or an unknown member is refused', async () => {
  for (const [method, body] of [
    ['GET', undefined],
    ['POST', { memberId: bob, dollars: 5 }],
  ] as const)
    expect(await asMember(bob, method, '/api/budgets', body)).toEqual({
      status: 403,
      body: JSON.stringify({
        error: 'missing_workspace_permission',
        message: 'Your workspace role does not allow this: Manage budgets',
      }),
    })
  expect(await ownBudgetOf(bob)).toEqual({ limitMicros: null, spentMicros: 0, percent: null })
  for (const body of [{ memberId: bob, dollars: 0 }, { memberId: bob }, { memberId: bob, dollars: '2' }])
    expect(await saveBudget(body)).toEqual({
      status: 400,
      body: { error: 'invalid_budget', message: 'A monthly budget is an amount above $0 and up to $1,000,000' },
    })
  expect((await saveBudget({ memberId: 'member-nobody', dollars: 1 })).body.error).toBe('budget_member_not_found')
  expect(await budgetEventsOf()).toEqual([])
})

test('an admin sets a member budget, audited once as budget.changed, and only that member sees it with this month’s spend', async () => {
  await spend(bob, 700_000)
  await spend(bob, 5_000_000, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 1))
  const { status, body } = await saveBudget({ memberId: bob, dollars: 1 })
  expect(status).toBe(200)
  expect(body.members).toEqual([
    { memberId: alice, name: 'Alice', limitMicros: null, spentMicros: 0, percent: null },
    { memberId: bob, name: 'Bob', limitMicros: 1_000_000, spentMicros: 700_000, percent: 70 },
    { memberId: lee, name: 'Lee', limitMicros: null, spentMicros: 0, percent: null },
  ])
  expect(body.workspace).toEqual({ limitMicros: null, spentMicros: 700_000, percent: null })
  await saveBudget({ memberId: bob, dollars: 1 })
  expect(await budgetEventsOf()).toEqual([
    { type: 'budget.changed', actorId: alice, payload: { memberId: bob, monthlyBudget: '$1.00' } },
  ])
  const audit = JSON.parse((await asMember(alice, 'GET', '/api/audit-log?group=Budgets')).body)
  expect(audit.entries.map(({ person, action, target }: Record<string, string>) => [person, action, target])).toEqual([
    ['Alice', 'Changed a monthly AI budget', 'Bob'],
  ])
  expect(await ownBudgetOf(bob)).toEqual({ limitMicros: 1_000_000, spentMicros: 700_000, percent: 70 })
  expect(await ownBudgetOf(lee)).toEqual({ limitMicros: null, spentMicros: 0, percent: null })
})

test('at 100% the member’s model call is refused before the gateway with the budget notice; raising the budget lets the next call through at once', async () => {
  await saveBudget({ memberId: bob, dollars: 1 })
  await spend(bob, 999_999)
  expect(await relayedCallOf(bob)).toMatchObject({ status: 200, reached: 1 })
  await spend(bob, 1)
  expect(await relayedCallOf(bob)).toEqual({ status: 402, reached: 0, failure: memberNotice })
  expect(await relayedCallOf(alice)).toMatchObject({ status: 200, reached: 1 })
  await saveBudget({ memberId: bob, dollars: 2 })
  expect(await relayedCallOf(bob)).toMatchObject({ status: 200, reached: 1, failure: null })
})

test('a reached workspace total refuses every member with the workspace wording, ahead of a member budget; removing it restores them', async () => {
  await saveBudget({ dollars: 1.5 })
  await saveBudget({ memberId: bob, dollars: 1 })
  await spend(alice, 500_000)
  await spend(bob, 1_000_000)
  expect(await relayedCallOf(alice)).toEqual({ status: 402, reached: 0, failure: workspaceNotice })
  expect(await relayedCallOf(bob)).toEqual({ status: 402, reached: 0, failure: workspaceNotice })
  await saveBudget({ dollars: null })
  expect(await relayedCallOf(alice)).toMatchObject({ status: 200, reached: 1 })
  expect(await relayedCallOf(bob)).toEqual({ status: 402, reached: 0, failure: memberNotice })
  const changes = (await budgetEventsOf()).filter((event) => event.type === 'budget.changed')
  expect(changes.map((event) => event.payload)).toEqual([
    { monthlyBudget: '$1.50' },
    { memberId: bob, monthlyBudget: '$1.00' },
    { monthlyBudget: 'None' },
  ])
})

test('alerts are recorded once per threshold per month at sync and at a budget change, synced only to their member and the admins, and cleared when the budget changes', async () => {
  await saveBudget({ memberId: bob, dollars: 1 })
  await spend(bob, 850_000)
  await sync()
  await sync()
  expect(await alertsOf()).toEqual([`${month}/80/${bob}`])
  await spend(bob, 200_000)
  await sync()
  await saveBudget({ dollars: 1.2 })
  expect(await alertsOf()).toEqual([`${month}/100/${bob}`, `${month}/80/${bob}`, `${month}/80/workspace`])
  expect(
    (await budgetEventsOf()).filter((event) => event.type === 'budget.threshold_reached').map((event) => event.payload),
  ).toEqual([
    { memberId: bob, threshold: 80, month },
    { memberId: bob, threshold: 100, month },
    { threshold: 80, month },
  ])

  const alertsSeenBy = async (userId: string) => {
    const store = await openZeroStore(createZeroStore, userId, [acme])
    return store
      .read()
      .budgetAlerts.map((alert) => alert.id)
      .toSorted()
  }
  await waitFor(async () => (await alertsSeenBy(alice)).length === 3)
  expect(await alertsSeenBy(bob)).toEqual([`${month}/100/${bob}`, `${month}/80/${bob}`])
  expect(await alertsSeenBy(lee)).toEqual([])

  await saveBudget({ memberId: bob, dollars: 5 })
  expect(await alertsOf()).toEqual([`${month}/80/workspace`])
})

const delegatingScript: FakeLlmScript = {
  steps: [{ tool: 'delegate', arguments: { task: 'List the files', effort: 'small' } }],
  text: 'Main done.',
  delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
  subagents: { 'fake-small': { steps: [{ command: 'echo started' }], text: 'Sub done.', hold: 'sub' } },
}

test('once the prompter’s budget is used up, a running sub-agent’s calls and the router of the next turn are refused before the gateway', async () => {
  const { host, launches } = await stack.agentHost('Budget delegation host', { routesModelCalls: true })
  const subs = () => (launches() as Launch[]).filter((launch) => launch.parent_conversation_id)
  const chat = await stack.newRuntimeChat()
  setFakeLlmScript(delegatingScript)
  await prompt(chat, 'Delegate slowly')
  await waitFor(() => subs().length === 1)
  await holds.reached('sub')
  const subToken = String(subs()[0]?.secrets.HQ_LLM_TOKEN?.value)
  await saveBudget({ memberId: alice, dollars: 1 })
  await spend(alice, 1_000_000)
  const callsBefore = fakeLlmCalls.length
  const subCall = await host.modelCall({
    headers: { authorization: `Bearer ${subToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake/fake-small', messages: [{ role: 'user', content: 'hi' }] }),
  })
  expect(subCall.status).toBe(402)
  expect(JSON.parse(subCall.body)).toEqual({
    error: {
      message: "Alice's monthly AI budget is used up; an admin can raise it in Workspace settings",
      type: 'hq_refused',
    },
  })
  await holds.release('sub')
  await waitFor(async () => (await turnOf(chat)) === null, 20_000)

  const nextChat = await stack.newRuntimeChat()
  const nextPrompt = await prompt(nextChat, 'Route this')
  await waitFor(async () =>
    JSON.stringify(await stack.repliesTo(nextPrompt, ['kind', 'body', 'step'])).includes(
      "Alice's monthly AI budget is used up",
    ),
  )
  await waitFor(async () => (await turnOf(nextChat)) === null)
  expect(fakeLlmCalls.length).toBe(callsBefore)
})
