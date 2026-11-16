import { beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { seedModelCall } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { createZeroStore } from '@spyria/db/zero-store'
import { syncUsageNow } from '@spyria/usage/server'
import type { FakeLlmScript } from './testing/fake-llm.ts'
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
await addLlmKey(bob, 'Mistral')
const lee = 'member-lee'
const zeroDatabase = zeroDrizzle(schema, database)
const sync = () =>
  syncUsageNow(
    { since: async () => ({ calls: [] }) },
    { workspaceId: acme, transact: (work) => zeroDatabase.transaction(work) },
  )
const noticeOf = (name: string, period: string) =>
  `${name}'s ${period} AI budget is used up; a member with the Manage budgets permission can raise it in Workspace settings`
const completion = JSON.stringify({ model: 'mistral/codestral-latest', messages: [{ role: 'user', content: 'hi' }] })
const today = new Date().toISOString().slice(0, 10)
const noLimits = { day: null, week: null, month: null }
const ownBudgetsOf = (limits: Record<string, number | null>, spentMicros: Record<string, number>) =>
  (['day', 'week', 'month'] as const).map((period) => ({
    period,
    limitMicros: limits[period] ?? null,
    spentMicros: spentMicros[period] ?? 0,
    percent: limits[period] ? Math.floor(((spentMicros[period] ?? 0) * 100) / (limits[period] ?? 1)) : null,
  }))

const spend = (prompterId: string, costMicros: number, calledAt?: Date) =>
  seedModelCall(database, prompterId, costMicros, calledAt)
const saveBudget = async (body: object, userId = alice) => {
  const answer = await asMember(userId, 'POST', '/api/budgets', body)
  return { status: answer.status, body: JSON.parse(answer.body) }
}
const saveMemberRoleBudget = (dollars: Record<string, number | null>) =>
  saveBudget({ roleId: 'member', dollars: { ...noLimits, ...dollars } })
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
  await database.$client`delete from role_budgets`
  await database.$client`delete from model_calls`
  await database.$client`delete from usage_entries`
  await database.$client`delete from workspace_events where type like 'budget.%'`
})

test('members are refused the budgets and read only their own; a malformed budget or an unknown role is refused', async () => {
  for (const [method, body] of [
    ['GET', undefined],
    ['POST', { roleId: 'member', dollars: { ...noLimits, day: 5 } }],
  ] as const)
    expect(await asMember(bob, method, '/api/budgets', body)).toEqual({
      status: 403,
      body: JSON.stringify({
        error: 'missing_workspace_permission',
        message: 'Your workspace role does not allow this: Manage budgets',
      }),
    })
  expect(await ownBudgetOf(bob)).toEqual(ownBudgetsOf({}, {}))
  for (const dollars of [{ ...noLimits, day: 0 }, { day: 1 }, { ...noLimits, month: '2' }])
    expect(await saveBudget({ roleId: 'member', dollars })).toEqual({
      status: 400,
      body: { error: 'invalid_budget', message: 'A budget is an amount above $0 and up to $1,000,000' },
    })
  expect((await saveBudget({ roleId: 'role-nobody', dollars: noLimits })).body.error).toBe('budget_role_not_found')
  expect(await budgetEventsOf()).toEqual([])
})

test('an admin sets a role’s budgets per member, audited once as budget.changed; each member of the role reads them with their own spend of the period', async () => {
  await spend(bob, 700_000)
  await spend(bob, 5_000_000, new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 1))
  const { status, body } = await saveMemberRoleBudget({ day: 1, month: 10 })
  expect(status).toBe(200)
  expect(body.roles).toEqual([
    { roleId: 'admin', name: 'Admin', memberCount: 1, limits: noLimits },
    { roleId: 'member', name: 'Member', memberCount: 2, limits: { day: 1_000_000, week: null, month: 10_000_000 } },
  ])
  expect(body.overAlertLine).toEqual([])
  await saveMemberRoleBudget({ day: 1, month: 10 })
  expect(await budgetEventsOf()).toEqual([
    {
      type: 'budget.changed',
      actorId: alice,
      payload: { role: 'member', dailyBudgetPerMember: '$1.00', monthlyBudgetPerMember: '$10.00' },
    },
  ])
  const audit = JSON.parse((await asMember(alice, 'GET', '/api/audit-log?group=Budgets')).body)
  expect(audit.entries.map(({ person, action, target }: Record<string, string>) => [person, action, target])).toEqual([
    ['Alice', "Changed a role's AI budget", 'Member'],
  ])
  const memberLimits = { day: 1_000_000, month: 10_000_000 }
  const bobSpendSinceMonthStart = await ownBudgetOf(bob)
  expect(bobSpendSinceMonthStart[0]).toEqual({
    period: 'day',
    limitMicros: 1_000_000,
    spentMicros: 700_000,
    percent: 70,
  })
  expect(bobSpendSinceMonthStart[2]).toEqual({
    period: 'month',
    limitMicros: 10_000_000,
    spentMicros: 700_000,
    percent: 7,
  })
  expect(await ownBudgetOf(lee)).toEqual(ownBudgetsOf(memberLimits, {}))
  expect(await ownBudgetOf(alice)).toEqual(ownBudgetsOf({}, {}))
})

test('at 100% of a period the member’s model call is refused before the gateway with that period’s notice, while the other members of the role go on; raising it lets the next call through at once', async () => {
  await saveMemberRoleBudget({ day: 1 })
  await spend(bob, 999_999)
  expect(await relayedCallOf(bob)).toMatchObject({ status: 200, reached: 1 })
  await spend(bob, 1)
  expect(await relayedCallOf(bob)).toEqual({ status: 402, reached: 0, failure: noticeOf('Bob', 'daily') })
  expect(await relayedCallOf(lee)).toMatchObject({ status: 200, reached: 1 })
  expect(await relayedCallOf(alice)).toMatchObject({ status: 200, reached: 1 })
  await saveMemberRoleBudget({ day: 2, month: 1 })
  expect(await relayedCallOf(bob)).toEqual({ status: 402, reached: 0, failure: noticeOf('Bob', 'monthly') })
  await saveMemberRoleBudget({ day: 2 })
  expect(await relayedCallOf(bob)).toMatchObject({ status: 200, reached: 1, failure: null })
})

test('alerts are recorded once per threshold, member and period at sync and at a budget change, synced only to their member and the admins, and cleared when the role’s budget changes', async () => {
  await saveMemberRoleBudget({ day: 1 })
  await spend(bob, 850_000)
  await sync()
  await sync()
  expect(await alertsOf()).toEqual([`day/${today}/80/${bob}`])
  await spend(bob, 200_000)
  await sync()
  await saveMemberRoleBudget({ day: 1, month: 1.2 })
  const month = `${today.slice(0, 7)}-01`
  expect(await alertsOf()).toEqual([`day/${today}/100/${bob}`, `day/${today}/80/${bob}`, `month/${month}/80/${bob}`])
  expect(
    (await budgetEventsOf()).filter((event) => event.type === 'budget.threshold_reached').map((event) => event.payload),
  ).toEqual([
    { memberId: bob, threshold: 80, period: 'day', startsOn: today },
    { memberId: bob, threshold: 100, period: 'day', startsOn: today },
    { memberId: bob, threshold: 80, period: 'month', startsOn: month },
  ])

  const alertsSeenBy = async (userId: string) => {
    const store = await openZeroStore(createZeroStore, userId, [acme])
    return store
      .read()
      .budgetAlerts.map((alert) => alert.id)
      .toSorted()
  }
  await waitFor(async () => (await alertsSeenBy(alice)).length === 3)
  expect(await alertsSeenBy(bob)).toHaveLength(3)
  expect(await alertsSeenBy(lee)).toEqual([])

  await saveMemberRoleBudget({ day: 5, month: 1.2 })
  expect(await alertsOf()).toEqual([`month/${month}/80/${bob}`])
})

const delegatingScript: FakeLlmScript = {
  steps: [{ tool: 'delegate', arguments: { task: 'List the files', effort: 'small' } }],
  text: 'Main done.',
  delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' },
  subagents: { 'mistral-small-latest': { steps: [{ command: 'echo started' }], text: 'Sub done.', hold: 'sub' } },
}

test('once the prompter’s budget is used up, a running sub-agent’s calls and the router of the next turn are refused before the gateway', async () => {
  const { host, launches } = await stack.agentHost('Budget delegation host', { routesModelCalls: true })
  const subs = () => (launches() as Launch[]).filter((launch) => launch.parent_conversation_id)
  const chat = await stack.newRuntimeChat()
  setFakeLlmScript(delegatingScript)
  await prompt(chat, 'Delegate slowly')
  await waitFor(() => subs().length === 1)
  await holds.reached('sub')
  const subToken = String(subs()[0]?.secrets.SPYRIA_LLM_TOKEN?.value)
  await saveBudget({ roleId: 'admin', dollars: { day: null, week: null, month: 1 } })
  await spend(alice, 1_000_000)
  const callsBefore = fakeLlmCalls.length
  const subCall = await host.modelCall({
    headers: { authorization: `Bearer ${subToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mistral/mistral-small-latest', messages: [{ role: 'user', content: 'hi' }] }),
  })
  expect(subCall.status).toBe(402)
  expect(JSON.parse(subCall.body)).toEqual({
    error: {
      message:
        "Alice's monthly AI budget is used up; a member with the Manage budgets permission can raise it in Workspace settings",
      type: 'spyria_refused',
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
