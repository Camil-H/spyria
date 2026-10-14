import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import type { ChatId } from '@hq/kernel'
import { acme, addLlmKey, aliceInAcme, bob, bobInAcme, startAgentStack, succeeded, waitFor } from '../testing.ts'
import { createHqAgentRelay } from './hq-agent-relay.ts'

setDefaultTimeout(40_000)
const { database, fakeHost, mutate, newRuntimeChat, prompt, turnOf, messagesOf, storedAgentEventsOf, ...stack } =
  await startAgentStack({
    routing: true,
    hqAgentImage: `sha256:${'0'.repeat(64)}`,
    hqAgentForWorkspaceHosts: true,
    resumeAfterMilliseconds: 15_000,
  })
const relays: ReturnType<typeof createHqAgentRelay>[] = []
afterEach(async () => {
  stack.setFakeLlmScript(undefined)
  await Promise.all(relays.splice(0).map((relay) => relay.stop()))
})

type Launch = {
  agent: { acp_command: string[]; acp_model?: string; acp_thought_level?: string; acp_resume_session_id?: string }
  secrets: Record<string, { value: string }>
  parent_conversation_id?: string
}
const workspaceHost = async () => {
  const relay = createHqAgentRelay()
  relays.push(relay)
  const host = await fakeHost('Workspace host', { agentServer: relay.agentServer })
  return { relay, host, launches: () => relay.created as Launch[] }
}
const keysOnly = async (...providers: string[]) => {
  await database.$client`delete from llm_credentials where user_id = ${bob}`
  for (const provider of providers) await addLlmKey(bob, provider)
}
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body', 'step'])
const finished = async (question: string, chat: ChatId) => {
  await waitFor(async () => (await repliesTo(question)).some((reply) => reply.body.includes('Hello from the stub')))
  await waitFor(async () => (await turnOf(chat)) === null)
  return repliesTo(question)
}
const commandShown = (question: string) =>
  waitFor(async () => (await repliesTo(question)).some((reply) => reply.body === 'command'))
const stop = async (chat: ChatId) => {
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await waitFor(async () => (await turnOf(chat)) === null)
}
const piFilesOf = ({ agent }: Launch) =>
  Object.fromEntries(
    agent.acp_command
      .filter((part) => /^(HQ_PI_\w+|HQ_COMPACTION_MODEL)=/.test(part))
      .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]),
  )
const decisionsOf = (chat: ChatId) =>
  database.$client`
    select role, model, member_id, conversation_id from routing_decisions
    where workspace_id = ${acme} and chat_id = ${chat} order by created_at`
const sessionsStartedOf = async (chat: ChatId) =>
  (await storedAgentEventsOf(chat))
    .map((event) => (event.payload as { event: { update: Record<string, unknown> } }).event.update)
    .filter((update) => update.sessionUpdate === 'session_started')

test.each([
  {
    provider: 'Anthropic',
    piProvider: 'hq-anthropic',
    baseUrl: 'http://fake-gateway-relay.test:4000',
    api: 'anthropic-messages',
    models: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-4-5'],
    model: 'anthropic/claude-sonnet-5-5',
  },
  {
    provider: 'OpenAI',
    piProvider: 'hq',
    baseUrl: 'http://fake-gateway-relay.test:4000/v1',
    api: 'openai-completions',
    models: ['openai/gpt-5', 'openai/gpt-5-mini', 'openai/gpt-5-nano'],
    model: 'openai/gpt-5-mini',
  },
  {
    provider: 'Mistral',
    piProvider: 'hq',
    baseUrl: 'http://fake-gateway-relay.test:4000/v1',
    api: 'openai-completions',
    models: ['mistral/mistral-large-latest', 'mistral/mistral-medium-latest', 'mistral/mistral-small-latest'],
    model: 'mistral/mistral-medium-latest',
  },
])(
  'a prompter with only an $provider key runs Pi on a workspace host with only the reachable models, and the turn streams and is stored once',
  async ({ provider, piProvider, baseUrl, api, models, model }) => {
    const { launches } = await workspaceHost()
    await keysOnly(provider)
    const chat = await newRuntimeChat()
    const { frames } = await stack.openStream(chat)
    await Bun.sleep(200)
    const replies = await finished(await prompt(chat, 'stub:tools', bobInAcme), chat)

    const acpModel = `${piProvider}/${model}`
    expect(replies.at(-1)?.body).toBe(`Hello from the stub (model ${acpModel}, mode bypassPermissions).`)
    expect(replies.filter((reply) => reply.body.includes('Hello from the stub'))).toHaveLength(1)
    expect(frames.join('')).toContain(`Hello from the stub (model ${acpModel}`)
    const [launch] = launches()
    expect(launches()).toHaveLength(1)
    expect(launch?.agent.acp_command.at(-1)).toEndWith('exec pi-acp')
    expect(launch?.agent).toMatchObject({ acp_model: acpModel, acp_thought_level: 'medium' })
    const files = piFilesOf(launch as Launch)
    const { providers } = JSON.parse(files.HQ_PI_MODELS ?? '{}')
    expect(Object.keys(providers)).toEqual([piProvider])
    expect(providers[piProvider]).toMatchObject({ baseUrl, api, apiKey: `\${HQ_LLM_TOKEN}` })
    expect(providers[piProvider].models.map(({ id }: { id: string }) => id).toSorted()).toEqual(models.toSorted())
    expect(providers[piProvider].models.every(({ reasoning }: { reasoning: boolean }) => reasoning)).toBe(true)
    expect(files.HQ_COMPACTION_MODEL).toBe(`${piProvider}/${models[2]}`)
    expect(Object.keys(launch?.secrets ?? {}).toSorted()).toEqual(['HQ_LLM_TOKEN', 'HQ_MCP_TOKEN'])
    for (const { value } of Object.values(launch?.secrets ?? {}))
      expect(JSON.stringify(launch?.agent)).not.toContain(value)
    expect([...(await decisionsOf(chat))]).toEqual([
      {
        role: 'session',
        model,
        member_id: bob,
        conversation_id: (await stack.runtimeOf(chat)).agent_conversation_id,
      },
    ])
  },
)

test('a routing change mid-session switches the same Pi session to the other provider’s model with the routed thinking level', async () => {
  const { relay, launches } = await workspaceHost()
  await keysOnly('Anthropic', 'OpenAI')
  const chat = await newRuntimeChat()
  stack.setFakeLlmScript({ route: { tier: 'large', confidence: 'high', effort: 'high' } })
  const first = await finished(await prompt(chat, 'Start large', bobInAcme), chat)
  expect(first.at(-1)?.body).toBe(
    '[t1] Hello from the stub (model hq-anthropic/anthropic/claude-opus-5-5, mode bypassPermissions).',
  )
  expect(launches()[0]?.agent).toMatchObject({ acp_thought_level: 'high' })

  expect(
    await mutate(bobInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      sessionModel: 'openai/gpt-5-mini',
    }),
  ).toEqual(succeeded)
  const second = await finished(await prompt(chat, 'Now on OpenAI', bobInAcme), chat)
  expect(second.map((reply) => reply.body)).toEqual([
    '[t2] Hello from the stub (model hq/openai/gpt-5-mini, mode bypassPermissions).',
  ])
  expect(relay.modelSwitches).toEqual(['hq/openai/gpt-5-mini'])
  expect(relay.thoughtLevels).toEqual(['high'])
  expect(launches()).toHaveLength(1)
  expect(relay.prompts).toEqual(['Start large', 'Now on OpenAI'])
})

test('Stop mid-command cancels the turn without deleting the conversation, and the next prompt continues the Pi session', async () => {
  const { launches } = await workspaceHost()
  const chat = await newRuntimeChat({ defaultModel: 'fake/fake-medium' })
  const stopped = await prompt(chat, 'stub:long')
  await commandShown(stopped)
  await stop(chat)
  expect((await repliesTo(stopped)).at(-1)).toMatchObject({ kind: 'notice', body: 'Stopped by Alice' })

  const replies = await finished(await prompt(chat, 'Carry on'), chat)
  expect(replies.at(-1)?.body).toStartWith('[t2] Hello from the stub')
  expect(replies.some((reply) => reply.body.includes('new session'))).toBe(false)
  expect(launches()).toHaveLength(1)
  expect(await sessionsStartedOf(chat)).toHaveLength(1)
})

test('delegation runs a Pi sub-conversation in the same runtime and answers with the sub’s text from its events', async () => {
  const { relay, host, launches } = await workspaceHost()
  const chat = await newRuntimeChat({ defaultModel: 'fake/fake-medium' })
  stack.setFakeLlmScript({ delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' } })
  const parent = await prompt(chat, 'stub:long')
  await commandShown(parent)
  const parentToken = launches()[0]?.secrets.HQ_LLM_TOKEN?.value ?? ''
  const answer = await host.modelCall({
    path: '/mcp/router',
    headers: { authorization: `Bearer ${parentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delegate', arguments: { task: 'List the files', effort: 'small' } },
    }),
  })
  expect(JSON.parse(answer.body).result).toEqual({
    content: [{ type: 'text', text: '[t1] Hello from the stub (model hq/fake/fake-small, mode bypassPermissions).' }],
    isError: false,
  })

  const [main, sub] = launches()
  expect(launches()).toHaveLength(2)
  expect(relay.agentCount()).toBe(1)
  expect(sub?.parent_conversation_id).toBe((await stack.runtimeOf(chat)).agent_conversation_id)
  expect(sub?.agent).toMatchObject({ acp_model: 'hq/fake/fake-small', acp_thought_level: 'low' })
  expect(sub?.agent.acp_command.at(-1)).toContain('.pi/sub')
  expect(main?.agent.acp_command.at(-1)).toContain('.pi/agent')
  expect(Object.keys(JSON.parse(piFilesOf(sub as Launch).HQ_PI_MCP ?? '{}').mcpServers)).toEqual(['hq'])
  expect(Object.keys(JSON.parse(piFilesOf(main as Launch).HQ_PI_MCP ?? '{}').mcpServers)).toEqual(['hq', 'router'])
  expect(sub?.secrets.HQ_LLM_TOKEN?.value).toStartWith('dl_')
  expect(sub?.secrets.HQ_MCP_TOKEN?.value).toBe(parentToken)
  expect(relay.prompts).toEqual(['stub:long', 'List the files'])
  expect([
    ...(await database.$client`select model, status, conversation_id from delegations where chat_id = ${chat}`),
  ]).toEqual([{ model: 'fake/fake-small', status: 'finished', conversation_id: expect.any(String) }])
  await stop(chat)
})

test('after a runtime restart the next prompt loads the Pi session and no earlier message is duplicated', async () => {
  const { relay, launches } = await workspaceHost()
  const chat = await newRuntimeChat({ defaultModel: 'fake/fake-medium' })
  await finished(await prompt(chat, 'Before the restart'), chat)
  const [firstSession] = await sessionsStartedOf(chat)

  await relay.restart()
  await finished(await prompt(chat, 'After the restart'), chat)
  expect(launches()).toHaveLength(2)
  expect(launches()[1]?.agent.acp_resume_session_id).toBe(String(firstSession?.sessionId))
  const sessions = await sessionsStartedOf(chat)
  expect(sessions.map(({ sessionId, resumeFailed }) => ({ sessionId, resumeFailed }))).toEqual([
    { sessionId: firstSession?.sessionId, resumeFailed: false },
    { sessionId: firstSession?.sessionId, resumeFailed: false },
  ])
  expect((await messagesOf(chat)).map(({ kind, body }) => `${kind}:${body}`)).toEqual([
    'member:Before the restart',
    'agent:[t1] Hello from the stub (model hq/fake/fake-medium, mode bypassPermissions).',
    'member:After the restart',
    'agent:[t2] Hello from the stub (model hq/fake/fake-medium, mode bypassPermissions).',
  ])
})
