import { expect, setDefaultTimeout, test } from 'bun:test'
import { type ChatId, reachableModelsOf, withPricesOf } from '@hq/kernel'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  chatAccessRows,
  chatAs,
  gatewayLogsOf,
  bob,
  bobInAcme,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(40_000)
const { database, app, gateway, llmGateway, setFakeLlmScript, mutate, prompt, repliesTo, ...stack } =
  await startAgentStack({ routing: true })
const newRuntimeChat = (ownerId = alice, participants: { memberId: string; roleId: string }[] = []) =>
  stack.newRuntimeChat({ ownerId, participants })

type Route = { tier: string; confidence: string | number; effort: string; prose?: boolean } | 'fail' | 'slow'
const routeWith = (route: Route) => setFakeLlmScript({ route })
const fakeAgent = () => stack.agentHost('Routing host', { routesModelCalls: true })
const answered = async (messageId: string) => {
  await waitFor(
    async () =>
      (await repliesTo(messageId)).some((reply) => reply.kind === 'agent' || !reply.body.includes('new session')),
    20_000,
  )
  return repliesTo(messageId)
}
const chatOf = async (chat: ChatId) =>
  (
    await database.$client`
      select model, reasoning_effort, subagent_policy, agent_model from chats where id = ${chat}`
  )[0]
const decisionsOf = (chat: ChatId) =>
  stack.decisionsOf(chat, ['role', 'model', 'reason', 'conversation_id', 'member_id', 'classifier_output'])
const logsOf = (chat: ChatId, minimum: number) => gatewayLogsOf(gateway, `metadata_chat=${chat}`, minimum)
const routing = (chat: ChatId, member: { workspaceId: string; userId: string }, fields: Record<string, unknown>) =>
  mutate(member, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, ...fields })
const routerLogsOf = async (chat: ChatId) =>
  (await logsOf(chat, 2)).filter((log) => log.metadata.role === 'router').map((log) => log.model)

test('the first prompt is classified once, on the prompter’s cheapest model with role router, and the session runs on the routed model', async () => {
  const { launches } = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  expect(await answered(await prompt(chat, 'Refactor the whole billing architecture'))).toEqual([
    { kind: 'agent', body: 'Understood, working on it.' },
  ])
  expect(launches()[0]?.agent).toMatchObject({ acp_model: 'hq/fake/fake-large', acp_thought_level: 'high' })
  const conversationId = (await database.$client`select agent_conversation_id from runtimes where chat_id = ${chat}`)[0]
    ?.agent_conversation_id
  expect(await chatOf(chat)).toMatchObject({
    model: 'fake/fake-large',
    reasoning_effort: 'high',
    agent_model: 'fake/fake-large',
  })
  expect([...(await decisionsOf(chat))]).toEqual([
    {
      role: 'session',
      model: 'fake/fake-large',
      reason: 'classified large',
      conversation_id: conversationId,
      member_id: alice,
      classifier_output: { tier: { value: 'large', confidence: 1 }, effort: { value: 'high', confidence: 1 } },
    },
  ])

  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'And a tiny follow-up'))
  expect(launches()).toHaveLength(1)
  expect(await decisionsOf(chat)).toHaveLength(1)
  const logs = await logsOf(chat, 3)
  const routerLogs = logs.filter((log) => log.metadata.role === 'router')
  expect(routerLogs).toHaveLength(1)
  expect(routerLogs[0]).toMatchObject({
    model: 'fake-small',
    metadata: { role: 'router', prompter: alice, owner: alice, chat, workspace: acme },
  })
  expect(logs.filter((log) => !log.metadata.role).map((log) => log.model)).toEqual(['fake-large', 'fake-large'])
})

test('a lost conversation is routed again for the new session', async () => {
  let lostConversationId = ''
  await stack.agentHost('Routing host', {
    routesModelCalls: true,
    containerAgentOf: (relay) => ({
      ...relay.containerAgent,
      respond: (request, container) =>
        lostConversationId && request.path === `/api/conversations/${lostConversationId}`
          ? { status: 404, body: '{}' }
          : relay.containerAgent.respond(request, container),
    }),
  })
  const chat = await newRuntimeChat()
  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'First session'))
  lostConversationId = String(
    (await database.$client`select agent_conversation_id from runtimes where chat_id = ${chat}`)[0]
      ?.agent_conversation_id,
  )
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(chat, 'After the runtime lost it'))
  expect((await decisionsOf(chat)).map((decision) => decision.model)).toEqual(['fake/fake-small', 'fake/fake-large'])
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-large', agent_model: 'fake/fake-large' })
})

test('the manual switch is refused for an unreachable model, recorded, and switched in the same session at the next prompt', async () => {
  const { relay, launches } = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(chat, 'Start on large'))

  const refused = await routing(chat, aliceInAcme, { sessionModel: 'anthropic/claude-opus-5-5' })
  expect(JSON.stringify(refused)).toContain('Your keys cannot reach Opus 5.5')
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-large' })

  expect(await routing(chat, aliceInAcme, { sessionModel: 'fake/fake-small' })).toEqual(succeeded)
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-small', agent_model: 'fake/fake-large' })
  expect((await decisionsOf(chat)).at(-1)).toMatchObject({ role: 'manual', model: 'fake/fake-small', member_id: alice })

  expect(await answered(await prompt(chat, 'Now on small'))).toEqual([
    { kind: 'agent', body: 'Understood, working on it.' },
  ])
  expect(relay.modelSwitches).toEqual(['hq/fake/fake-small'])
  expect(launches()).toHaveLength(1)
  expect(await chatOf(chat)).toMatchObject({ agent_model: 'fake/fake-small' })

  expect(await routing(chat, aliceInAcme, { sessionModel: 'fake/fake-large' })).toEqual(succeeded)
  await answered(await prompt(chat, 'Back to large'))
  expect(relay.modelSwitches).toEqual(['hq/fake/fake-small', 'hq/fake/fake-large'])
  expect(relay.thoughtLevels).toEqual(['high', 'high'])
  const agentModels = (await logsOf(chat, 4)).filter((log) => !log.metadata.role).map((log) => log.model)
  expect(agentModels.toSorted()).toEqual(['fake-large', 'fake-large', 'fake-small'])
})

test('a member whose keys reach only a decision model gets the no-key notice and no decision model to choose', async () => {
  await fakeAgent()
  await addLlmKey(bob, 'Typesafe')
  const chat = await newRuntimeChat(bob)
  expect(await answered(await prompt(chat, 'Only Jev here', bobInAcme))).toEqual([
    { kind: 'notice', body: 'Bob has no LLM key in this workspace' },
  ])
  const response = await app.request(`/api/chats/${chat}/routing`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, bob)}` },
  })
  expect(((await response.json()) as { reachableModels: unknown[] }).reachableModels).toEqual([])
})

test('a prompter reaching only a small model routes to it, and is refused in a session on a model his keys cannot reach', async () => {
  const { relay, launches } = await fakeAgent()
  await addLlmKey(bob, 'Fake-small')
  const bobChat = await newRuntimeChat(bob)
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(bobChat, 'Big job', bobInAcme))
  expect(await chatOf(bobChat)).toMatchObject({ model: 'fake-small/fake-small' })
  expect(launches().map((launch) => launch.agent.acp_model)).toEqual(['hq/fake-small/fake-small'])

  const aliceChat = await newRuntimeChat(alice, [{ memberId: bob, roleId: 'editor' }])
  await answered(await prompt(aliceChat, 'Alice starts on large'))
  await routing(aliceChat, aliceInAcme, { sessionModel: 'fake/fake-large' })
  const bobPrompt = await prompt(aliceChat, 'Bob joins', bobInAcme)
  expect(await answered(bobPrompt)).toEqual([
    { kind: 'notice', body: 'Your keys cannot reach Fake large; switch the model or add a key' },
  ])
  expect(relay.prompts).not.toContain('Bob joins')
  expect(JSON.stringify(await routing(aliceChat, bobInAcme, { sessionModel: 'fake/fake-large' }))).toContain(
    'Your keys cannot reach Fake large',
  )
})

test('the routing read lists the member’s reachable models and the context tokens of the latest call from model_calls', async () => {
  const chat = await newRuntimeChat()
  await database.$client`
    insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider, input_tokens, output_tokens, cost_micros, status, called_at)
    values (${acme}, ${crypto.randomUUID()}, ${chat}, ${alice}, ${alice}, 'fake-large', 'fake', 100, 20, 3600, 'success', now() - interval '1 minute'),
           (${acme}, ${crypto.randomUUID()}, ${chat}, ${bob}, ${alice}, 'fake-large', 'fake', 300, 30, 9900, 'success', now() - interval '40 days'),
           (${acme}, ${crypto.randomUUID()}, ${chat}, ${alice}, ${alice}, 'fake-small', 'fake', 400, 50, 2700, 'success', now())`
  const response = await app.request(`/api/chats/${chat}/routing`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
  })
  expect(await response.json()).toMatchObject({
    reachableModels: [
      { id: 'fake/fake-large', dollarsPerMillionInputTokens: 30 },
      { id: 'fake/fake-medium', dollarsPerMillionInputTokens: 15 },
      { id: 'fake/fake-small', dollarsPerMillionInputTokens: 6 },
    ],
    contextTokens: 450,
  })
})

test.each(chatAccessRows(['reader', 'prompter', 'editor', 'owner', 'public']))(
  'the routing read needs chat.read: $name',
  async (role) => {
    const response = await app.request(`/api/chats/${await chatAs(role)}/routing`, {
      headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, role.userId)}` },
    })
    expect(response.status).toBe(role.isAllowed ? 200 : 403)
    expect(await response.json()).toMatchObject(
      role.isAllowed
        ? { reachableModels: expect.any(Array) }
        : { error: 'missing_chat_permission', message: 'You need the chat.read permission on this chat' },
    )
  },
)

let decisionModelKey: Promise<void> | undefined
type RoutingRow = {
  title: string
  decisionModel?: boolean
  route: Route
  model: string
  effort?: string
  reason?: string
  routerModel?: string
}
test.each<RoutingRow>([
  {
    title: 'a low-confidence classification',
    route: { tier: 'large', confidence: 'low', effort: 'medium' },
    model: 'fake/fake-medium',
    reason: 'default',
  },
  {
    title: 'a failed classification',
    route: 'fail',
    model: 'fake/fake-medium',
    reason: 'routing unavailable: HTTP 500',
  },
  {
    title: 'a timed-out classification',
    route: 'slow',
    model: 'fake/fake-medium',
    reason: 'routing unavailable: timeout',
  },
  {
    title: 'a chat classifier answering JSON inside prose',
    route: { tier: 'small', confidence: 'high', effort: 'low', prose: true },
    model: 'fake/fake-small',
    effort: 'low',
    routerModel: 'fake-small',
  },
  {
    title: 'a decision model confident at 0.9',
    decisionModel: true,
    route: { tier: 'large', confidence: 0.9, effort: 'high' },
    model: 'fake/fake-large',
    routerModel: 'jev-latest',
  },
  {
    title: 'a decision model unsure at 0.5',
    decisionModel: true,
    route: { tier: 'large', confidence: 0.5, effort: 'high' },
    model: 'fake/fake-medium',
    routerModel: 'jev-latest',
  },
  { title: 'a timed-out decision model', decisionModel: true, route: 'slow', model: 'fake/fake-medium' },
])('after $title the first prompt routes to $model', async (row) => {
  const { launches } = await fakeAgent()
  if (row.decisionModel) {
    decisionModelKey ??= addLlmKey(alice, 'Typesafe')
    await decisionModelKey
  }
  const chat = await newRuntimeChat()
  routeWith(row.route)
  const startedAt = Date.now()
  await answered(await prompt(chat, `Route ${JSON.stringify(row.route)}`))
  if (row.route === 'slow') expect(Date.now() - startedAt).toBeLessThan(10_000)
  expect(await chatOf(chat)).toMatchObject({
    model: row.model,
    ...(row.effort && { reasoning_effort: row.effort }),
  })
  expect(launches()[0]?.agent.acp_model).toBe(`hq/${row.model}`)
  if (row.reason)
    expect((await decisionsOf(chat))[0]).toMatchObject({ role: 'session', model: row.model, reason: row.reason })
  if (row.routerModel) expect(await routerLogsOf(chat)).toEqual([row.routerModel])
})

test('a prompter with only an OpenAI key is routed to an OpenAI model, recorded with its reason, and never to an Anthropic one', async () => {
  const { launches } = await fakeAgent()
  await database.$client`delete from llm_credentials where user_id = ${bob}`
  await addLlmKey(bob, 'OpenAI')
  const unsureChat = await newRuntimeChat(bob)
  routeWith({ tier: 'large', confidence: 'low', effort: 'medium' })
  await answered(await prompt(unsureChat, 'Unsure on OpenAI', bobInAcme))
  expect(await chatOf(unsureChat)).toMatchObject({ model: 'openai/gpt-5-mini', agent_model: 'openai/gpt-5-mini' })
  expect(await decisionsOf(unsureChat)).toMatchObject([
    { role: 'session', model: 'openai/gpt-5-mini', reason: 'default', member_id: bob },
  ])
  expect(await routerLogsOf(unsureChat)).toEqual(['gpt-5-nano'])

  const largeChat = await newRuntimeChat(bob)
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(largeChat, 'Large on OpenAI', bobInAcme))
  expect(await decisionsOf(largeChat)).toMatchObject([
    { role: 'session', model: 'openai/gpt-5', reason: 'classified large', member_id: bob },
  ])
  expect(launches().map((launch) => launch.agent.acp_model)).toEqual(['hq/openai/gpt-5-mini', 'hq/openai/gpt-5'])
})

test('the real listing gives datasheet prices to the routable models a key reaches, and only those are offered', async () => {
  await addLlmKey(alice, 'OpenAI')
  await llmGateway.refreshListedModels()
  const listing = llmGateway.listedModels()
  expect(listing.map((model) => model.id)).toContain('openai/fake-large')
  expect(withPricesOf(reachableModelsOf(['openai']), listing)).toMatchObject([
    {
      id: 'openai/gpt-5',
      name: 'GPT-5',
      tier: 'large',
      dollarsPerMillionInputTokens: 1.25,
      dollarsPerMillionOutputTokens: 10,
    },
    { id: 'openai/gpt-5-mini', name: 'GPT-5 mini', tier: 'medium', dollarsPerMillionInputTokens: 0.25 },
    { id: 'openai/gpt-5-nano', name: 'GPT-5 nano', tier: 'small', dollarsPerMillionInputTokens: 0.05 },
  ])
})

test('a runtime chat started from a thread sends nothing until the first prompt, which reaches the model as the thread then the prompt, once', async () => {
  const { relay } = await fakeAgent()
  const post = async (member: typeof aliceInAcme, text: string, threadRootId?: string) => {
    const id = `message-${crypto.randomUUID()}`
    expect(
      await mutate(member, 'conversation.sendMessage', {
        workspaceId: acme,
        id,
        chatId: 'chat-welcome',
        text,
        threadRootId,
      }),
    ).toEqual(succeeded)
    return id
  }
  const root = await post(aliceInAcme, 'Can we ship the invoice fix?')
  const reply = await post(bobInAcme, 'Yes, after review.', root)
  const chat = `chat-${crypto.randomUUID()}` as ChatId
  expect(
    await mutate(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId: chat,
      messageId: reply,
    }),
  ).toEqual(succeeded)
  expect(await routing(chat, aliceInAcme, { runsOn: 'runtime' })).toEqual(succeeded)
  expect(relay.prompts).toEqual([])
  const wrapper = (await database.query.messages.findFirst({ where: { chatId: chat }, orderBy: { seq: 'asc' } }))?.body
  expect(wrapper).toStartWith('Conversation so far, from the channel thread in #Welcome:')
  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'Summarise the thread.'))
  await answered(await prompt(chat, 'And then?'))
  const firstPrompt = `${wrapper}\n\nSummarise the thread.`
  expect(relay.prompts).toEqual([firstPrompt, 'And then?'])
  expect(stack.fakeLlmBodies.some((body) => body.includes(JSON.stringify(firstPrompt).slice(1, -1)))).toBe(true)
})

test('a first prompt deleted before it was sent leaves the seed to the next prompt', async () => {
  const chat = `chat-${crypto.randomUUID()}` as ChatId
  expect(
    await mutate(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId: chat,
      messageId: 'message-welcome-1',
    }),
  ).toEqual(succeeded)
  expect(await routing(chat, aliceInAcme, { runsOn: 'runtime' })).toEqual(succeeded)
  const deletedPrompt = await prompt(chat, 'Never sent.')
  expect(
    await mutate(aliceInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: deletedPrompt }),
  ).toEqual(succeeded)
  const { relay } = await fakeAgent()
  const wrapper = (await database.query.messages.findFirst({ where: { chatId: chat }, orderBy: { seq: 'asc' } }))?.body
  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'Summarise the thread.'))
  expect(relay.prompts).toEqual([`${wrapper}\n\nSummarise the thread.`])
})

test('a fork sends nothing until the forker’s first prompt, which reaches the model as the source history then the prompt, once, routed on the forker’s keys', async () => {
  const { relay } = await fakeAgent()
  await addLlmKey(bob, 'OpenAI')
  const source = await newRuntimeChat(alice, [{ memberId: bob, roleId: 'reader' }])
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, ${source}, ${`message-${crypto.randomUUID()}`}, 1, 'member', ${alice}, 'Find the bug.', now()),
      (${acme}, ${source}, ${`message-${crypto.randomUUID()}`}, 2, 'agent', null, 'Found it.', now())`
  const fork = `chat-${crypto.randomUUID()}` as ChatId
  expect(
    await mutate(bobInAcme, 'conversation.forkChat', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId: fork,
      sourceChatId: source,
    }),
  ).toEqual(succeeded)
  expect(await routing(fork, bobInAcme, { runsOn: 'runtime' })).toEqual(succeeded)
  expect(relay.prompts).toEqual([])
  const wrapper = (await database.query.messages.findFirst({ where: { chatId: fork } }))?.body
  expect(wrapper).toStartWith('Conversation so far, from the runtime chat Runtime chat:')
  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(fork, 'Fix it.', bobInAcme))
  await answered(await prompt(fork, 'And then?', bobInAcme))
  const firstPrompt = `${wrapper}\n\nFix it.`
  expect(relay.prompts).toEqual([firstPrompt, 'And then?'])
  expect(stack.fakeLlmBodies.some((body) => body.includes(JSON.stringify(firstPrompt).slice(1, -1)))).toBe(true)
  expect(await decisionsOf(fork)).toMatchObject([{ role: 'session', member_id: bob }])
})
