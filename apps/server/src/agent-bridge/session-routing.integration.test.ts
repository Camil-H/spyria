import { expect, setDefaultTimeout, test } from 'bun:test'
import { type ChatId, reachableModelsOf, withPricesOf } from '@hq/kernel'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  gatewayLogsOf,
  bob,
  bobInAcme,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing.ts'
import { createFakeAgentServer } from './fake-agent-server.ts'

setDefaultTimeout(40_000)
const { database, app, gateway, llmGateway, setFakeLlmScript, fakeHost, mutate, prompt, repliesTo, ...stack } =
  await startAgentStack({ routing: true })
const newRuntimeChat = (defaultModel: string | null = 'fake/fake-medium', ownerId = alice) =>
  stack.newRuntimeChat({ defaultModel, ownerId })

type Route = { tier: string; confidence: string | number; effort: string; prose?: boolean } | 'fail' | 'slow'
const routeWith = (route: Route) => setFakeLlmScript({ route })
const fakeAgent = async () => {
  const fake = createFakeAgentServer({ modelCall: () => host.modelCall })
  const host = await fakeHost('Routing host', { agentServer: fake.agentServer })
  return fake
}
type Llm = { model: string; usage_id: string; reasoning_effort?: string }
const llmOf = (conversation: { created: Record<string, unknown> } | undefined) =>
  (conversation?.created.agent as { llm?: Llm } | undefined)?.llm
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
      select model, reasoning_effort, default_model, subagent_policy, agent_model from chats where id = ${chat}`
  )[0]
const decisionsOf = async (chat: ChatId) =>
  database.$client`
    select role, model, reason, conversation_id, member_id, classifier_output from routing_decisions
    where workspace_id = ${acme} and chat_id = ${chat} order by created_at`
const logsOf = (chat: ChatId, minimum: number) => gatewayLogsOf(gateway, `metadata_chat=${chat}`, minimum)
const routing = (chat: ChatId, member: { workspaceId: string; userId: string }, fields: Record<string, unknown>) =>
  mutate(member, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, ...fields })
const routerLogsOf = async (chat: ChatId) =>
  (await logsOf(chat, 2)).filter((log) => log.metadata.role === 'router').map((log) => log.model)

test('the first prompt is classified once, on the prompter’s cheapest model with role router, and the session runs on the routed model', async () => {
  const fake = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  expect(await answered(await prompt(chat, 'Refactor the whole billing architecture'))).toEqual([
    { kind: 'agent', body: 'Understood, working on it.' },
  ])
  const [conversation] = [...fake.conversations.values()]
  expect(conversation?.created.agent).toMatchObject({
    llm: { model: 'openai/fake/fake-large', reasoning_effort: 'high', usage_id: 'agent' },
  })
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
      conversation_id: conversation?.id,
      member_id: alice,
      classifier_output: { tier: { value: 'large', confidence: 1 }, effort: { value: 'high', confidence: 1 } },
    },
  ])

  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'And a tiny follow-up'))
  expect(fake.conversations.size).toBe(1)
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
  const fake = await fakeAgent()
  const chat = await newRuntimeChat()
  routeWith({ tier: 'small', confidence: 'high', effort: 'low' })
  await answered(await prompt(chat, 'First session'))
  fake.conversations.clear()
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(chat, 'After the runtime lost it'))
  expect((await decisionsOf(chat)).map((decision) => decision.model)).toEqual(['fake/fake-small', 'fake/fake-large'])
  expect(await chatOf(chat)).toMatchObject({ model: 'fake/fake-large', agent_model: 'fake/fake-large' })
})

test('the manual switch is refused for an unreachable model, recorded, and applied with a fresh usage_id at the next prompt', async () => {
  const fake = await fakeAgent()
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
  const [conversation] = [...fake.conversations.values()]
  const switched = llmOf(conversation)
  expect(switched?.model).toBe('openai/fake/fake-small')
  expect(switched?.usage_id).not.toBe('agent')
  expect(fake.conversations.size).toBe(1)
  expect(await chatOf(chat)).toMatchObject({ agent_model: 'fake/fake-small' })

  expect(await routing(chat, aliceInAcme, { sessionModel: 'fake/fake-large' })).toEqual(succeeded)
  await answered(await prompt(chat, 'Back to large'))
  const switchedBack = llmOf(conversation)
  expect(switchedBack?.model).toBe('openai/fake/fake-large')
  expect([...new Set([switched?.usage_id, switchedBack?.usage_id, 'agent'])]).toHaveLength(3)
  const agentModels = (await logsOf(chat, 4)).filter((log) => !log.metadata.role).map((log) => log.model)
  expect(agentModels.toSorted()).toEqual(['fake-large', 'fake-large', 'fake-small'])
})

test('a member whose keys reach only a decision model gets the no-key notice and no decision model to choose', async () => {
  await fakeAgent()
  await addLlmKey(bob, 'Typesafe')
  const chat = await newRuntimeChat('fake/fake-medium', bob)
  expect(await answered(await prompt(chat, 'Only Jev here', bobInAcme))).toEqual([
    { kind: 'notice', body: 'Bob has no LLM key in this workspace' },
  ])
  const response = await app.request(`/api/chats/${chat}/routing`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, bob)}` },
  })
  expect(((await response.json()) as { reachableModels: unknown[] }).reachableModels).toEqual([])
})

test('a prompter reaching only a small model routes to it, and is refused in a session on a model his keys cannot reach', async () => {
  const fake = await fakeAgent()
  await addLlmKey(bob, 'Fake-small')
  const bobChat = await newRuntimeChat('fake/fake-medium', bob)
  routeWith({ tier: 'large', confidence: 'high', effort: 'high' })
  await answered(await prompt(bobChat, 'Big job', bobInAcme))
  expect(await chatOf(bobChat)).toMatchObject({ model: 'fake-small/fake-small' })
  expect(
    [...fake.conversations.values()].map(
      (conversation) => (conversation.created.agent as { llm: { model: string } }).llm.model,
    ),
  ).toEqual(['openai/fake-small/fake-small'])

  const aliceChat = await newRuntimeChat()
  await answered(await prompt(aliceChat, 'Alice starts on large'))
  await routing(aliceChat, aliceInAcme, { sessionModel: 'fake/fake-large' })
  const bobPrompt = await prompt(aliceChat, 'Bob joins', bobInAcme)
  expect(await answered(bobPrompt)).toEqual([
    { kind: 'notice', body: 'Your keys cannot reach Fake large; switch the model or add a key' },
  ])
  expect(fake.prompts.map((sent) => sent.text)).not.toContain('Bob joins')
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

let decisionModelKey: Promise<void> | undefined
type RoutingRow = {
  decisionModel?: boolean
  route: Route
  defaultModel?: string
  model: string
  effort?: string
  reason?: string
  routerModel?: string
}
test.each<RoutingRow>([
  {
    route: { tier: 'large', confidence: 'low', effort: 'medium' },
    defaultModel: 'fake/fake-small',
    model: 'fake/fake-small',
    reason: 'default',
  },
  { route: 'fail', defaultModel: 'fake/fake-small', model: 'fake/fake-small', reason: 'default' },
  { route: 'slow', defaultModel: 'fake/fake-small', model: 'fake/fake-small', reason: 'default' },
  {
    route: { tier: 'small', confidence: 'high', effort: 'low', prose: true },
    model: 'fake/fake-small',
    effort: 'low',
    routerModel: 'fake-small',
  },
  {
    decisionModel: true,
    route: { tier: 'large', confidence: 0.9, effort: 'high' },
    model: 'fake/fake-large',
    routerModel: 'jev-latest',
  },
  {
    decisionModel: true,
    route: { tier: 'large', confidence: 0.5, effort: 'high' },
    model: 'fake/fake-medium',
    routerModel: 'jev-latest',
  },
  { decisionModel: true, route: 'slow', model: 'fake/fake-medium' },
])('the first prompt routes to $model with a decision model $decisionModel and the route $route', async (row) => {
  const fake = await fakeAgent()
  if (row.decisionModel) {
    decisionModelKey ??= addLlmKey(alice, 'Typesafe')
    await decisionModelKey
  }
  const chat = await newRuntimeChat(row.defaultModel)
  routeWith(row.route)
  const startedAt = Date.now()
  await answered(await prompt(chat, `Route ${JSON.stringify(row.route)}`))
  if (row.route === 'slow') expect(Date.now() - startedAt).toBeLessThan(10_000)
  expect(await chatOf(chat)).toMatchObject({
    model: row.model,
    ...(row.effort && { reasoning_effort: row.effort }),
  })
  expect(llmOf([...fake.conversations.values()][0])?.model).toBe(`openai/${row.model}`)
  if (row.reason)
    expect((await decisionsOf(chat))[0]).toMatchObject({ role: 'session', model: row.model, reason: row.reason })
  if (row.routerModel) expect(await routerLogsOf(chat)).toEqual([row.routerModel])
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

test('a prompter reaching only Anthropic locks the session on Claude Code without routing, and an invitee without an Anthropic key is refused', async () => {
  const fake = await fakeAgent()
  await database.$client`delete from llm_credentials where user_id = ${bob}`
  await addLlmKey(bob, 'Anthropic')
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Claude Code starts', bobInAcme))
  const [conversation] = [...fake.conversations.values()]
  expect(conversation?.created).toMatchObject({
    agent: {
      kind: 'ACPAgent',
      acp_server: 'claude-code',
      acp_command: [
        'env',
        'ANTHROPIC_BASE_URL=http://fake-gateway-relay.test:4000',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1',
        'CLAUDE_CODE_MAX_RETRIES=0',
        'ANTHROPIC_MODEL=claude-opus-5-5',
        'claude-agent-acp',
      ],
      mcp_config: { hq: { url: 'http://fake-gateway-relay.test:4000/mcp', transport: 'http' } },
    },
    secrets: { ANTHROPIC_API_KEY: { kind: 'StaticSecret' } },
    autotitle: false,
  })
  expect(Object.keys((conversation?.created.agent as { mcp_config?: object } | undefined)?.mcp_config ?? {})).toEqual([
    'hq',
  ])
  expect(await chatOf(chat)).toMatchObject({ model: 'anthropic/claude-opus-5-5' })
  expect((await database.$client`select harness from chats where id = ${chat}`)[0]?.harness).toBe('claude-code')
  expect(await decisionsOf(chat)).toHaveLength(0)

  const alicePrompt = await prompt(chat, 'Alice joins the Claude Code session')
  expect(await answered(alicePrompt)).toEqual([
    { kind: 'notice', body: 'This session runs Claude Code on Anthropic keys' },
  ])
  expect(fake.prompts.map((sent) => sent.text)).not.toContain('Alice joins the Claude Code session')
  expect(fake.conversations.size).toBe(1)
  expect(JSON.stringify(await routing(chat, bobInAcme, { sessionModel: 'anthropic/claude-sonnet-5-5' }))).toContain(
    'This session runs Claude Code',
  )
})

test('a prompter reaching only OpenAI locks the session on Codex through the relay without an OpenAI key in its environment, and an invitee without an OpenAI key is refused', async () => {
  const fake = await fakeAgent()
  await database.$client`delete from llm_credentials where user_id = ${bob}`
  await database.$client`delete from llm_credentials where user_id = ${alice} and secret_ref like 'gateway:openai/%'`
  await addLlmKey(bob, 'OpenAI')
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Codex starts', bobInAcme))
  const [conversation] = [...fake.conversations.values()]
  const agent = conversation?.created.agent as { acp_command: string[] }
  expect(conversation?.created).toMatchObject({
    agent: {
      kind: 'ACPAgent',
      acp_server: 'codex',
      mcp_config: { hq: { url: 'http://fake-gateway-relay.test:4000/mcp', transport: 'http' } },
    },
    secrets: { OPENAI_API_KEY: { kind: 'StaticSecret' } },
    autotitle: false,
  })
  expect(Object.keys(conversation?.created.secrets ?? {})).toEqual(['OPENAI_API_KEY'])
  const [env, codexConfig, modelProvider, globalConfig, catalogScript, shell, shellFlag, launcher] = agent.acp_command
  expect([env, modelProvider, shell, shellFlag]).toEqual(['env', 'MODEL_PROVIDER=hq', 'sh', '-c'])
  expect(JSON.parse(codexConfig?.replace('CODEX_CONFIG=', '') ?? '{}')).toEqual({
    model: 'gpt-6.1-sol',
    model_providers: {
      hq: {
        name: 'HQ',
        base_url: 'http://fake-gateway-relay.test:4000/v1',
        env_key: 'OPENAI_API_KEY',
        wire_api: 'responses',
        supports_websockets: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
  })
  expect(globalConfig).toContain('model_provider = "off"')
  expect(globalConfig).toContain('plugins = false')
  expect(catalogScript).toContain("slug: 'gpt-6.1-sol'")
  expect(launcher).toEndWith('exec codex-acp')
  const secrets = conversation?.created.secrets as Record<string, { value: string }>
  expect(JSON.stringify(agent.acp_command)).not.toContain(String(secrets.OPENAI_API_KEY?.value))
  expect(await chatOf(chat)).toMatchObject({ model: 'openai/gpt-6.1-sol' })
  expect((await database.$client`select harness from chats where id = ${chat}`)[0]?.harness).toBe('codex')
  expect(await decisionsOf(chat)).toHaveLength(0)

  expect(await answered(await prompt(chat, 'Alice joins the Codex session'))).toEqual([
    { kind: 'notice', body: 'This session runs Codex on OpenAI keys' },
  ])
  expect(fake.prompts.map((sent) => sent.text)).not.toContain('Alice joins the Codex session')
  expect(fake.conversations.size).toBe(1)
  expect(JSON.stringify(await routing(chat, bobInAcme, { sessionModel: 'openai/gpt-5' }))).toContain(
    'This session runs Codex',
  )
})
