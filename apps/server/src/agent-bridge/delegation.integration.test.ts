import { expect, setDefaultTimeout, test } from 'bun:test'
import { stillRunningOf, subagentFailureOf, unknownTaskOf } from '@hq/conversation/server'
import { type ChatId, messageId } from '@hq/kernel'
import type { FakeLlmScript } from '../fake-llm.ts'
import {
  acme,
  alice,
  aliceInAcme,
  type FakeHost,
  gatewayLogsOf,
  type Launch,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(40_000)
const { database, gateway, setFakeLlmScript, agentBridge, fakeHost, mutate, prompt, turnOf, holds, ...stack } =
  await startAgentStack({ routing: true, resumeAfterMilliseconds: 5_000 })
const newRuntimeChat = () => stack.newRuntimeChat()
const repliesTo = (promptId: string) => stack.repliesTo(promptId, ['kind', 'body', 'step'])

const delegatedTask = { tool: 'delegate', arguments: { task: 'List the files', effort: 'small' } }
const confidentSmall = { tier: 'small', confidence: 'high', effort: 'low' }
const heldWork = { steps: [{ command: 'echo started' }], text: 'one two three four five six', hold: 'sub' }
const delegatingScript = (script: FakeLlmScript = {}): FakeLlmScript => ({
  steps: [delegatedTask],
  text: 'Main done.',
  delegateRoute: confidentSmall,
  subagents: { 'fake-small': { steps: [{ command: 'echo sub' }], text: 'Sub done.' } },
  ...script,
})
const fakeAgent = async () => {
  const { relay, host, launches } = await stack.agentHost('Delegation host', { routesModelCalls: true })
  return {
    relay,
    host,
    main: () => launches().find((launch) => !launch.parent_conversation_id),
    subs: () => launches().filter((launch) => launch.parent_conversation_id),
  }
}
const tokenOf = (launch: Launch | undefined, name = 'HQ_LLM_TOKEN') => String(launch?.secrets[name]?.value)
const promptAndAnswer = async (chat: ChatId, text: string) => {
  const id = await prompt(chat, text)
  await waitFor(async () => (await repliesTo(id)).some((reply) => reply.kind === 'agent'), 20_000)
  await waitFor(async () => (await turnOf(chat)) === null)
  return id
}
const delegationsOf = (chat: ChatId) =>
  database.$client`
    select id, conversation_id, action_event_id, model, reason, policy, status, token_hash, finished_at, classifier_output
    from delegations
    where workspace_id = ${acme} and chat_id = ${chat} order by created_at`
const completionWith = (host: FakeHost, token: string) =>
  host.modelCall({
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake/fake-small', messages: [{ role: 'user', content: 'hi' }] }),
  })
const routerCallWith = (host: FakeHost, token: string) =>
  host.modelCall({
    path: '/mcp/router',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate', arguments: {} } }),
  })
const toolListWith = (host: FakeHost, token: string) =>
  host.modelCall({
    path: '/mcp',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
test('a delegated task runs in a Pi sub-conversation on the classified model, its events are stored once and in order, and the tool answers with the sub’s final message', async () => {
  const { relay, host, main, subs } = await fakeAgent()
  const chat = await newRuntimeChat()
  const subagent = { steps: [{ command: 'echo sub', say: 'Let me look.' }], text: 'Sub done.' }
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': subagent } }))
  const promptId = await promptAndAnswer(chat, 'Delegate the listing')

  const [sub] = subs()
  expect(subs()).toHaveLength(1)
  expect(relay.agentCount()).toBe(1)
  expect(relay.prompts).toEqual(['Delegate the listing', 'List the files'])
  expect(sub?.parent_conversation_id).toBe((await stack.runtimeOf(chat)).agent_conversation_id)
  expect(sub?.agent).toMatchObject({ acp_model: 'hq/fake/fake-small', acp_thought_level: 'low' })
  expect(tokenOf(sub)).toStartWith('dl_')
  expect(main()?.agent.acp_model).toBe('hq/fake/fake-medium')

  const [delegation] = await delegationsOf(chat)
  expect(delegation).toMatchObject({
    model: 'fake/fake-small',
    reason: 'classified small',
    policy: 'auto',
    status: 'finished',
  })
  expect(delegation?.token_hash).not.toContain(tokenOf(sub))
  expect(delegation?.finished_at).not.toBeNull()
  expect(delegation?.classifier_output).not.toBeNull()

  const stored = await database.$client`
    select id, payload from events where workspace_id = ${acme} and chat_id = ${chat}
      and payload->'delegation'->>'id' = ${delegation?.id} order by seq`
  expect(stored.length).toBeGreaterThan(0)
  expect(new Set(stored.map((row) => row.id)).size).toBe(stored.length)
  expect(stored.every((row) => String(row.id).startsWith(`${delegation?.conversation_id}:`))).toBe(true)
  const seqs = stored.map((row) => Number(row.payload.event.seq))
  expect(seqs).toEqual(seqs.toSorted((first, second) => first - second))
  expect(stored[0]?.payload.delegation).toEqual({
    id: delegation?.id,
    model: 'fake/fake-small',
    modelName: 'Fake small',
    task: 'List the files',
  })

  const replies = await repliesTo(promptId)
  const stepDelegation = stored[0]?.payload.delegation
  expect(
    replies.map(({ kind, body, step }) => ({ kind, body, delegation: (step as { delegation?: object })?.delegation })),
  ).toEqual([
    { kind: 'step', body: 'tool', delegation: undefined },
    { kind: 'step', body: 'command', delegation: stepDelegation },
    { kind: 'agent', body: 'Main done.', delegation: undefined },
  ])
  expect(replies[0]?.step).toMatchObject({ name: 'delegate', result: 'Sub done.' })

  for (const log of await gatewayLogsOf(gateway, `metadata_chat=${chat}&metadata_role=delegate`, 2))
    expect(log).toMatchObject({
      model: 'fake-small',
      metadata: { role: 'delegate', delegation: delegation?.id, prompter: alice, owner: alice },
    })
  expect((await completionWith(host, tokenOf(sub))).status).toBe(401)
})

test('the delegation token works only while its delegation runs and only from its runtime host, and the router refuses it and answers no active turn', async () => {
  const { host, main, subs } = await fakeAgent()
  const chat = await newRuntimeChat()
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': heldWork } }))
  const answered = promptAndAnswer(chat, 'Delegate slowly')
  await waitFor(() => subs().length === 1)
  const subToken = tokenOf(subs()[0])
  expect(tokenOf(subs()[0], 'HQ_MCP_TOKEN')).toBe(subToken)
  const otherHost = await fakeHost('Other host')
  expect((await completionWith(otherHost, subToken)).status).toBe(401)
  expect((await completionWith(host, subToken)).status).toBe(200)
  expect((await toolListWith(host, subToken)).status).toBe(200)
  expect((await routerCallWith(host, subToken)).status).toBe(401)
  await holds.release('sub')
  await answered

  expect((await completionWith(host, subToken)).status).toBe(401)
  expect((await toolListWith(host, subToken)).status).toBe(401)
  const withoutTurn = await routerCallWith(host, tokenOf(main(), 'HQ_MCP_TOKEN'))
  expect(withoutTurn.status).toBe(200)
  expect(JSON.parse(withoutTurn.body).result).toEqual({
    content: [{ type: 'text', text: 'This runtime has no active turn' }],
    isError: true,
  })
})

const stepsOf = async (promptId: string) =>
  (await repliesTo(promptId)).map((reply) => reply.step as { name?: string; result?: string; isError?: boolean } | null)

test.each([
  {
    policy: 'auto',
    route: 'fail',
    asked: undefined,
    model: 'fake/fake-medium',
    reason: 'routing unavailable: HTTP 500',
  },
  {
    policy: 'same_as_main',
    route: confidentSmall,
    asked: undefined,
    model: 'fake/fake-medium',
    reason: 'same as main',
  },
  { policy: 'auto', route: confidentSmall, asked: 'fake-large', model: 'fake/fake-large', reason: 'asked' },
  { policy: 'same_as_main', route: confidentSmall, asked: 'large', model: 'fake/fake-large', reason: 'asked' },
] as const)(
  'a model asked by the agent comes before the policy, then the classifier: $policy, route $route, asked $asked',
  async ({ policy, route, asked, model, reason }) => {
    const { subs } = await fakeAgent()
    const chat = await newRuntimeChat()
    const routing = { workspaceId: acme, chatId: chat, subagentPolicy: policy }
    expect(await mutate(aliceInAcme, 'conversation.updateChatRouting', routing)).toEqual(succeeded)
    const step = { ...delegatedTask, arguments: { ...delegatedTask.arguments, model: asked } }
    const subagent = { steps: [{ command: 'echo sub' }], text: `Sub on ${model}.` }
    setFakeLlmScript(
      delegatingScript({ steps: [step], delegateRoute: route, subagents: { [model.replace('fake/', '')]: subagent } }),
    )
    await promptAndAnswer(chat, `Delegate with ${policy}`)
    expect(subs().map((sub) => sub.agent.acp_model)).toEqual([`hq/${model}`])
    expect(
      (await delegationsOf(chat)).map(({ model, reason, policy, classifier_output }) => ({
        model,
        reason,
        policy,
        classifier_output,
      })),
    ).toEqual([{ model, reason, policy, classifier_output: null }])
  },
)

test('a long task answers still running before Pi’s timeout for the router, a resume call returns its result, and another chat or turn cannot resume it', async () => {
  const { subs, main } = await fakeAgent()
  const chat = await newRuntimeChat()
  const resumeCall = {
    ...delegatedTask,
    arguments: { ...delegatedTask.arguments, resume: '$resume' },
    hold: 'resume',
  }
  setFakeLlmScript(delegatingScript({ steps: [delegatedTask, resumeCall], subagents: { 'fake-small': heldWork } }))
  const startedAt = Date.now()
  const promptId = await prompt(chat, 'Delegate a long task')
  await holds.reached('resume')
  const mcp = main()
    ?.agent.acp_command.find((part) => part.startsWith('HQ_PI_MCP='))
    ?.slice('HQ_PI_MCP='.length)
  expect(Date.now() - startedAt).toBeLessThan(JSON.parse(String(mcp)).mcpServers.router.timeout * 1000)
  await waitFor(async () => (await stepsOf(promptId))[0]?.result?.startsWith('Task ') === true)
  const [delegation] = await delegationsOf(chat)
  const id = String(delegation?.id)
  expect((await stepsOf(promptId))[0]?.result).toBe(stillRunningOf(id))
  const otherTurn = { promptId: messageId('message-other'), prompterId: alice, ownerId: alice, prompterName: 'Alice' }
  const resumeElsewhere = (otherChat: ChatId) =>
    agentBridge.forDatabase(database).delegate({
      chat: { workspaceId: acme, chatId: otherChat },
      turn: otherTurn,
      task: '',
      effort: 'small',
      resume: id,
    })
  expect(await resumeElsewhere(await newRuntimeChat())).toEqual({ text: unknownTaskOf(id), isError: true })
  expect(await resumeElsewhere(chat)).toEqual({ text: unknownTaskOf(id), isError: true })
  await holds.release('sub')
  await waitFor(async () => (await delegationsOf(chat))[0]?.status === 'finished')
  await holds.release('resume')
  await waitFor(async () => (await repliesTo(promptId)).some((reply) => reply.kind === 'agent'))

  expect(subs()).toHaveLength(1)
  expect((await delegationsOf(chat)).map((row) => ({ id: row.id, status: row.status }))).toEqual([
    { id, status: 'finished' },
  ])
  const delegateSteps = (await stepsOf(promptId)).filter((step) => step?.name === 'delegate')
  expect(delegateSteps.map((step) => step?.result)).toEqual([stillRunningOf(id), 'one two three four five six'])
})

test('a long task the turn never resumed is forgotten when the turn ends', async () => {
  await fakeAgent()
  const chat = await newRuntimeChat()
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': heldWork } }))
  const promptId = await promptAndAnswer(chat, 'Delegate and move on')
  const [delegation] = await delegationsOf(chat)
  const id = String(delegation?.id)
  expect((await stepsOf(promptId))[0]?.result).toBe(stillRunningOf(id))
  const resumed = await agentBridge.forDatabase(database).delegate({
    chat: { workspaceId: acme, chatId: chat },
    turn: { promptId: messageId(promptId), prompterId: alice, ownerId: alice, prompterName: 'Alice' },
    task: '',
    effort: 'small',
    resume: id,
  })
  expect(resumed).toEqual({ text: unknownTaskOf(id), isError: true })
  await holds.release('sub')
  await waitFor(async () => (await delegationsOf(chat))[0]?.status === 'finished')
})

test('stopping the turn interrupts the running subagent, marks its delegation stopped, and the next prompt runs', async () => {
  const { relay } = await fakeAgent()
  const chat = await newRuntimeChat()
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': heldWork } }))
  const promptId = await prompt(chat, 'Delegate then stop')
  await waitFor(async () => (await repliesTo(promptId)).length >= 2, 20_000)
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await waitFor(async () => (await delegationsOf(chat))[0]?.status === 'stopped')
  const subConversationId = String((await delegationsOf(chat))[0]?.conversation_id)
  await waitFor(() => relay.interrupts.includes(subConversationId))

  setFakeLlmScript({ text: 'Back to normal.' })
  const nextId = await promptAndAnswer(chat, 'Carry on')
  expect((await repliesTo(nextId)).map(({ kind, body }) => ({ kind, body }))).toEqual([
    { kind: 'agent', body: 'Back to normal.' },
  ])
})

test('a failed subagent answers the tool call with an error in HQ wording and leaves the main turn untouched', async () => {
  await fakeAgent()
  const chat = await newRuntimeChat()
  const failing = { steps: [{ command: 'echo sub' }, { fail: 'Overloaded' }] }
  setFakeLlmScript(delegatingScript({ subagents: { 'fake-small': failing } }))
  const promptId = await promptAndAnswer(chat, 'Delegate a failing task')

  const [delegation] = await delegationsOf(chat)
  expect(delegation?.status).toBe('failed')
  const replies = await repliesTo(promptId)
  const [delegateStep] = await stepsOf(promptId)
  expect(delegateStep).toMatchObject({ name: 'delegate', isError: true })
  expect(delegateStep?.result).toStartWith(subagentFailureOf('Fake small', ''))
  expect(replies.at(-1)).toMatchObject({ kind: 'agent', body: 'Main done.' })
  expect(replies.filter((reply) => reply.kind === 'notice')).toEqual([])
  expect(
    (await database.$client`select agent_turn_failure from chats where id = ${chat}`)[0]?.agent_turn_failure,
  ).toBeNull()
})
