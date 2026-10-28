import { expect, setDefaultTimeout, test } from 'bun:test'
import type { ChatId } from '@spyria/kernel'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  type Launch,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(40_000)
const { database, mutate, newRuntimeChat, prompt, turnOf, messagesOf, storedAgentEventsOf, ...stack } =
  await startAgentStack({ routing: true })
const workspaceHost = () => stack.agentHost('Workspace host')
const keysOnly = async (...providers: string[]) => {
  await database.$client`delete from llm_credentials where user_id = ${bob}`
  for (const provider of providers) await addLlmKey(bob, provider)
}
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body', 'step'])
const finished = (question: string, chat: ChatId) => stack.finished(question, chat, 15_000)
const stop = async (chat: ChatId) => {
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await waitFor(async () => (await turnOf(chat)) === null)
}
const piFilesOf = ({ agent }: Launch) =>
  Object.fromEntries(
    agent.acp_command
      .filter((part) => /^(SPYRIA_PI_\w+|SPYRIA_COMPACTION_MODEL)=/.test(part))
      .map((part) => [part.slice(0, part.indexOf('=')), part.slice(part.indexOf('=') + 1)]),
  )
const decisionsOf = (chat: ChatId) => stack.decisionsOf(chat, ['role', 'model', 'member_id', 'conversation_id'])
const sessionsStartedOf = async (chat: ChatId) =>
  (await storedAgentEventsOf(chat))
    .map((event) => (event.payload as { event: { update: Record<string, unknown> } }).event.update)
    .filter((update) => update.sessionUpdate === 'session_started')

test.each([
  {
    provider: 'Anthropic',
    piProvider: 'spyria-anthropic',
    baseUrl: 'http://fake-gateway-relay.test:4000',
    api: 'anthropic-messages',
    models: ['anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-haiku-5-5'],
    model: 'anthropic/claude-sonnet-5-5',
  },
  {
    provider: 'OpenAI',
    piProvider: 'spyria',
    baseUrl: 'http://fake-gateway-relay.test:4000/v1',
    api: 'openai-completions',
    models: ['openai/gpt-5', 'openai/gpt-5-mini', 'openai/gpt-5-nano'],
    model: 'openai/gpt-5-mini',
  },
  {
    provider: 'Mistral',
    piProvider: 'spyria',
    baseUrl: 'http://fake-gateway-relay.test:4000/v1',
    api: 'openai-completions',
    models: ['mistral/mistral-large-latest', 'mistral/mistral-medium-latest', 'mistral/mistral-small-latest'],
    model: 'mistral/mistral-medium-latest',
  },
  ...[
    {
      provider: 'OpenRouter',
      models: [
        'openrouter/anthropic/claude-opus-5.5',
        'openrouter/anthropic/claude-sonnet-5.5',
        'openrouter/anthropic/claude-haiku-5.5',
      ],
    },
    {
      provider: 'Google',
      models: ['gemini/gemini-pro-latest', 'gemini/gemini-flash-latest', 'gemini/gemini-flash-lite-latest'],
    },
    { provider: 'xAI', models: ['xai/grok-4.7', 'xai/grok-4.3', 'xai/grok-code-fast'] },
    {
      provider: 'DeepSeek',
      models: ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2'],
    },
    { provider: 'Z.ai', models: ['zai/glm-5.3', 'zai/glm-4.7', 'zai/glm-5.3-flash'] },
  ].map(({ provider, models }) => ({
    provider,
    piProvider: 'spyria',
    baseUrl: 'http://fake-gateway-relay.test:4000/v1',
    api: 'openai-completions',
    models,
    model: models[1] as string,
  })),
])(
  'a prompter with only an $provider key runs Pi on a workspace host with only the reachable models, and the turn streams and is stored once',
  async ({ provider, piProvider, baseUrl, api, models, model }) => {
    const { launches } = await workspaceHost()
    await keysOnly(provider)
    const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
    const frames = await stack.subscribedFrames(chat)
    const replies = await finished(await prompt(chat, 'stub:tools', bobInAcme), chat)

    const adapterModel = `${piProvider}/${model}`
    expect(replies.at(-1)?.body).toBe(`Hello from the stub (model ${adapterModel}, mode default).`)
    expect(replies.filter((reply) => reply.body.includes('Hello from the stub'))).toHaveLength(1)
    expect(frames.join('')).toContain(`Hello from the stub (model ${adapterModel}`)
    const [launch] = launches()
    expect(launches()).toHaveLength(1)
    expect(launch?.agent.acp_command.at(-1)).toEndWith('exec pi --mode rpc --no-themes')
    expect(launch?.agent).toMatchObject({ acp_model: adapterModel, acp_thought_level: 'medium' })
    const files = piFilesOf(launch as Launch)
    const { providers } = JSON.parse(files.SPYRIA_PI_MODELS ?? '{}')
    expect(Object.keys(providers)).toEqual([piProvider])
    expect(providers[piProvider]).toMatchObject({ baseUrl, api, apiKey: `\${SPYRIA_LLM_TOKEN}` })
    expect(providers[piProvider].models.map(({ id }: { id: string }) => id).toSorted()).toEqual(models.toSorted())
    expect(providers[piProvider].models.every(({ reasoning }: { reasoning: boolean }) => reasoning)).toBe(true)
    expect(files.SPYRIA_COMPACTION_MODEL).toBe(`${piProvider}/${models[2]}`)
    expect(Object.keys(launch?.secrets ?? {}).toSorted()).toEqual(['SPYRIA_LLM_TOKEN', 'SPYRIA_MCP_TOKEN'])
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
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  stack.setFakeLlmScript({ route: { tier: 'large', confidence: 'high', effort: 'high' } })
  const first = await finished(await prompt(chat, 'Start large', bobInAcme), chat)
  expect(first.at(-1)?.body).toBe(
    '[t1] Hello from the stub (model spyria-anthropic/anthropic/claude-opus-5-5, mode default).',
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
    '[t2] Hello from the stub (model spyria/openai/gpt-5-mini, mode default).',
  ])
  expect(relay.modelSwitches).toEqual(['spyria/openai/gpt-5-mini'])
  expect(relay.thoughtLevels).toEqual(['high'])
  expect(launches()).toHaveLength(1)
  expect(relay.prompts).toEqual(['Start large', 'Now on OpenAI'])
})

test('an effort change keeps the model and session and sets Pi’s thinking level once, on the next turn only; a malformed effort is refused', async () => {
  const { relay, launches } = await workspaceHost()
  await keysOnly('Anthropic')
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  await finished(await prompt(chat, 'Start', bobInAcme), chat)
  const setEffort = (reasoningEffort: string) =>
    mutate(bobInAcme, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, reasoningEffort })
  expect(await setEffort('Max!')).not.toEqual(succeeded)
  expect(await setEffort('high')).toEqual(succeeded)
  const second = await finished(await prompt(chat, 'Think harder', bobInAcme), chat)
  expect(second.map((reply) => reply.body)).toEqual([
    '[t2] Hello from the stub (model spyria-anthropic/anthropic/claude-sonnet-5-5, mode default).',
  ])
  await finished(await prompt(chat, 'Same effort', bobInAcme), chat)
  expect(relay.thoughtLevels).toEqual(['high'])
  expect(launches()).toHaveLength(1)
})

test('a manual pick from the full listing relaunches Pi with that model on the same session; an unlisted model is refused', async () => {
  const { launches } = await workspaceHost()
  await keysOnly('OpenRouter')
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  const first = await finished(await prompt(chat, 'Start on OpenRouter', bobInAcme), chat)
  expect(first.at(-1)?.body).toBe(
    '[t1] Hello from the stub (model spyria/openrouter/anthropic/claude-sonnet-5.5, mode default).',
  )
  const [firstSession] = await sessionsStartedOf(chat)
  const pick = (sessionModel: string) =>
    mutate(bobInAcme, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, sessionModel })
  expect(await pick('openrouter/vendor/not-listed')).not.toEqual(succeeded)
  expect(await pick('openrouter/moonshotai/kimi-k3')).toEqual(succeeded)

  const second = await finished(await prompt(chat, 'Now on Kimi', bobInAcme), chat)
  expect(second.map((reply) => reply.body)).toEqual([
    '[t2] Hello from the stub (model spyria/openrouter/moonshotai/kimi-k3, mode default).',
  ])
  expect(launches()).toHaveLength(2)
  const relaunch = launches()[1] as Launch
  expect(relaunch.agent).toMatchObject({
    acp_model: 'spyria/openrouter/moonshotai/kimi-k3',
    acp_resume_session_id: String(firstSession?.sessionId),
  })
  const { providers } = JSON.parse(piFilesOf(relaunch).SPYRIA_PI_MODELS ?? '{}')
  expect(providers.spyria.models.map(({ id }: { id: string }) => id)).toEqual([
    'openrouter/anthropic/claude-opus-5.5',
    'openrouter/anthropic/claude-sonnet-5.5',
    'openrouter/anthropic/claude-haiku-5.5',
    'openrouter/moonshotai/kimi-k3',
  ])
  expect(piFilesOf(relaunch).SPYRIA_COMPACTION_MODEL).toBe('spyria/openrouter/anthropic/claude-haiku-5.5')
})

test('g2. a curated pick on a provider whose key was added after Pi launched relaunches Pi on the same session with that model, and the next turn answers on it with the context kept', async () => {
  const { relay, launches } = await workspaceHost()
  await keysOnly('Anthropic')
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  const first = await finished(await prompt(chat, 'Start on Anthropic', bobInAcme), chat)
  expect(first.at(-1)?.body).toStartWith('[t1] Hello from the stub (model spyria-anthropic/anthropic/')
  const [firstSession] = await sessionsStartedOf(chat)
  await addLlmKey(bob, 'OpenAI')
  expect(
    await mutate(bobInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      sessionModel: 'openai/gpt-5-mini',
    }),
  ).toEqual(succeeded)

  const second = await finished(await prompt(chat, 'Now on OpenAI', bobInAcme), chat)
  expect(second.map((reply) => reply.body)).toEqual([
    '[t2] Hello from the stub (model spyria/openai/gpt-5-mini, mode default).',
  ])
  expect(relay.modelSwitches).toEqual(['spyria/openai/gpt-5-mini'])
  expect(launches()).toHaveLength(2)
  const relaunch = launches()[1] as Launch
  expect(relaunch.agent).toMatchObject({
    acp_model: 'spyria/openai/gpt-5-mini',
    acp_resume_session_id: String(firstSession?.sessionId),
  })
  const { providers } = JSON.parse(piFilesOf(relaunch).SPYRIA_PI_MODELS ?? '{}')
  expect(providers.spyria.models.map(({ id }: { id: string }) => id)).toContain('openai/gpt-5-mini')
  expect(relay.prompts).toEqual(['Start on Anthropic', 'Now on OpenAI'])
})

test('Stop mid-command cancels the turn without deleting the conversation, and the next prompt continues the Pi session', async () => {
  const { launches } = await workspaceHost()
  const chat = await newRuntimeChat()
  const stopped = await prompt(chat, 'stub:long')
  await stack.commandShown(stopped)
  await stop(chat)
  expect((await repliesTo(stopped)).at(-1)).toMatchObject({ kind: 'notice', body: 'Stopped by Alice' })

  const replies = await finished(await prompt(chat, 'Carry on'), chat)
  expect(replies.at(-1)?.body).toStartWith('[t2] Hello from the stub')
  expect(replies.some((reply) => reply.body.includes('new session'))).toBe(false)
  expect(launches()).toHaveLength(1)
  expect(await sessionsStartedOf(chat)).toHaveLength(1)
})

test('the pages the agent opens with Spyria’s open_page tool are kept for the chat’s Browser, newest first, and an address of another scheme or on the member’s own network is refused with a reason the agent sees', async () => {
  await stack.agentHost('Browser host', { routesModelCalls: true })
  const chat = await newRuntimeChat()
  const openPage = (address: string, title?: string) => ({
    tool: 'mcp__spyria__open_page',
    arguments: { address, ...(title && { title }) },
  })
  stack.setFakeLlmScript({
    steps: [
      openPage('/workspace/project/reports/totals.html', 'Invoice totals'),
      openPage('javascript:alert(1)', 'Script'),
      openPage('http://localhost:3000/admin', 'Admin'),
      openPage('http://192.168.1.1', 'Router'),
      openPage('https://example.com/docs'),
    ],
    text: 'Opened.',
  })
  const promptId = await prompt(chat, 'Show me the totals')
  const replies = await stack.finished(promptId, chat, 15_000, 'Opened.')
  expect(replies.at(-1)?.body).toBe('Opened.')
  expect([
    ...(await database.$client`
      select url, title from browser_pages where workspace_id = ${acme} and chat_id = ${chat} order by opened_at desc`),
  ]).toEqual([
    { url: 'https://example.com/docs', title: 'https://example.com/docs' },
    { url: 'reports/totals.html', title: 'Invoice totals' },
  ])
  const results = (await stack.repliesTo(promptId, ['step'])).flatMap(({ step }) =>
    (step as { name?: string })?.name === 'open_page' ? [(step as { result?: string }).result] : [],
  )
  expect(results).toEqual([
    "The page is open in the member's Browser panel.",
    'Only http and https addresses and project files are opened',
    "http://localhost:3000/admin is on the member's own machine or network, so it is not opened",
    "http://192.168.1.1 is on the member's own machine or network, so it is not opened",
    "The page is open in the member's Browser panel.",
  ])
  expect(
    await database.$client`
      select server, tool, status from tool_calls where workspace_id = ${acme} and chat_id = ${chat} order by called_at`,
  ).toMatchObject([
    { server: 'spyria', tool: 'open_page', status: 'succeeded' },
    { server: 'spyria', tool: 'open_page', status: 'refused' },
    { server: 'spyria', tool: 'open_page', status: 'refused' },
    { server: 'spyria', tool: 'open_page', status: 'refused' },
    { server: 'spyria', tool: 'open_page', status: 'succeeded' },
  ])
})

test('the agent takes a screenshot of a page with Spyria’s take_screenshot tool, saved in the runtime and shown in the chat through the runtime’s media, and a page that fails or a request that is not valid answers why', async () => {
  await stack.agentHost('Screenshot host', { routesModelCalls: true })
  const chat = await newRuntimeChat()
  const takeScreenshot = (fields: Record<string, unknown>) => ({
    tool: 'mcp__spyria__take_screenshot',
    arguments: fields,
  })
  stack.setFakeLlmScript({
    steps: [
      takeScreenshot({ url: 'http://localhost:3000/settings', theme: 'dark', viewport: 'mobile' }),
      takeScreenshot({ url: 'http://localhost:9/refused' }),
      takeScreenshot({ url: 'file:///etc/passwd' }),
    ],
    text: 'Here it is: ![Settings](.spyria/screenshots/localhost-3000-settings.png)',
  })
  const promptId = await prompt(chat, 'Show me the settings page')
  await stack.finished(promptId, chat, 15_000, 'Here it is')
  const results = (await stack.repliesTo(promptId, ['step'])).flatMap(({ step }) =>
    (step as { name?: string })?.name === 'take_screenshot' ? [(step as { result?: string }).result] : [],
  )
  expect(results).toEqual([
    'Saved .spyria/screenshots/localhost-3000-settings.png. Show it to the members with ![Screenshot of http://localhost:3000/settings](.spyria/screenshots/localhost-3000-settings.png)',
    'The screenshot of http://localhost:9/refused failed: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/refused',
    'Give the http or https address of the page to take a screenshot of',
  ])
  const shown = await stack.app.request(
    `/api/chats/${chat}/media?${new URLSearchParams({ path: '.spyria/screenshots/localhost-3000-settings.png' })}`,
    { headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` } },
  )
  expect(shown.status).toBe(200)
  expect(shown.headers.get('content-type')).toBe('image/png')
  expect(
    await database.$client`
      select tool, status from tool_calls where workspace_id = ${acme} and chat_id = ${chat} order by called_at`,
  ).toMatchObject([
    { tool: 'take_screenshot', status: 'succeeded' },
    { tool: 'take_screenshot', status: 'refused' },
    { tool: 'take_screenshot', status: 'refused' },
  ])
})

test('the chat keeps how full the agent’s context is from its latest model call, with the window of the model it ran on, and forgets it when the model changes', async () => {
  await stack.agentHost('Context host', { routesModelCalls: true })
  const chat = await newRuntimeChat()
  const contextOf = async () =>
    (
      await database.$client`
        select agent_model, context_tokens, context_window from chats where workspace_id = ${acme} and id = ${chat}`
    )[0]
  expect(await contextOf()).toMatchObject({ context_tokens: null, context_window: null })

  stack.setFakeLlmScript({ text: 'Hi.' })
  await stack.finished(await prompt(chat, 'Hello'), chat, 15_000, 'Hi.')
  const { agent_model: model, ...context } = (await contextOf()) ?? {}
  expect(context).toEqual({
    context_tokens: 2,
    context_window: stack.llmGateway.listedModels().find((listed) => listed.id === model)?.contextWindow ?? null,
  })
  const unknown = { context_tokens: null, context_window: null }

  expect(
    await mutate(aliceInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      sessionModel: 'mistral/mistral-large-latest',
    }),
  ).toEqual(succeeded)
  expect(await contextOf()).toMatchObject(unknown)
})

test('a new session of the agent forgets the context size its chat kept from the one before', async () => {
  await workspaceHost()
  const chat = await newRuntimeChat()
  await database.$client`
    update chats set context_tokens = 5000, context_window = 128000 where workspace_id = ${acme} and id = ${chat}`
  await finished(await prompt(chat, 'Hello'), chat)
  const [context] = await database.$client`
    select context_tokens, context_window from chats where workspace_id = ${acme} and id = ${chat}`
  expect(context).toEqual({ context_tokens: null, context_window: null })
})

test('after a runtime restart the next prompt loads the Pi session and no earlier message is duplicated', async () => {
  const { relay, launches } = await workspaceHost()
  const chat = await newRuntimeChat()
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
    'agent:[t1] Hello from the stub (model spyria/mistral/mistral-medium-latest, mode default).',
    'member:After the restart',
    'agent:[t2] Hello from the stub (model spyria/mistral/mistral-medium-latest, mode default).',
  ])
})
