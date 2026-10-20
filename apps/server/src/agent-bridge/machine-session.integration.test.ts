import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { rebuildMessages } from '@spyria/conversation/server'
import { schema } from '@spyria/db/zero'
import { type ChatId, chatId, defaultHarness, runtimeHostId } from '@spyria/kernel'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  failedWith,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(40_000)
const { database, app, mutate, newRuntimeChat, prompt, turnOf, messagesOf, storedAgentEventsOf, finished, ...stack } =
  await startAgentStack()
afterEach(async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id = ${alice} and removed_at is null`
})

const machine = async ({
  gapMilliseconds,
  startFails,
  signedIn = [defaultHarness],
}: {
  gapMilliseconds?: number
  startFails?: boolean
  signedIn?: string[]
} = {}) => (await stack.agentHost('Machine', { ownerId: alice, signedIn, gapMilliseconds, startFails })).relay
const newMachineChat = () => newRuntimeChat({ harness: defaultHarness })
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body', 'step'])
const bodiesOf = (replies: { kind: string; body: string }[]) =>
  replies.map(({ kind, body }) => (kind === 'step' ? body : `${kind}:${body}`))
const subscribeBeforeStoredMilliseconds = 200
const streamedText = (frames: string[], isReasoning = false) =>
  frames
    .map((frame) => JSON.parse(frame) as { text?: string; isReasoning?: boolean })
    .filter((frame) => frame.text !== undefined && (frame.isReasoning ?? false) === isReasoning)
    .map((frame) => frame.text)
    .join('')
type AdapterChoices<Current extends string> = { [key in Current]: string | null } & {
  available: { id: string; name: string }[]
}
const routingReadOf = async (chat: ChatId) =>
  (await (
    await app.request(`/api/chats/${chat}/routing`, {
      headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, alice)}` },
    })
  ).json()) as { adapterModels: AdapterChoices<'currentModelId'>; adapterEfforts: AdapterChoices<'current'> }
const routingOf = async (chat: ChatId) => (await routingReadOf(chat)).adapterModels

const toolsRepliesOf = (model: string) => [
  'agent:[t1]',
  'file',
  'agent:permission:allow-always',
  'command',
  `agent:Hello from the stub (model ${model}, mode bypassPermissions).`,
]
const toolsReplies = toolsRepliesOf('stub-default')

test.each([
  { harness: 'claude-code', model: 'stub-default' },
  { harness: 'codex', model: 'gpt-stub' },
])(
  'a $harness turn on the machine streams text, shows final steps with the diff, ends once and launches with no base URL and no key',
  async ({ harness, model }) => {
    const relay = await machine({ signedIn: [harness] })
    const chat = await newRuntimeChat({ harness })
    const frames = await stack.subscribedFrames(chat)
    const question = await prompt(chat, 'stub:tools')
    const replies = await finished(question, chat)

    expect(bodiesOf(replies)).toEqual(toolsRepliesOf(model))
    expect(replies[1]?.step).toMatchObject({
      type: 'file',
      operation: 'edit',
      path: 'app.ts',
      added: 1,
      removed: 1,
      diff: [
        { kind: 'removed', text: 'one' },
        { kind: 'added', text: 'two' },
      ],
    })
    expect(replies[3]?.step).toMatchObject({ type: 'command', command: 'npm test', exitCode: 1, output: 'exit code 1' })
    expect(replies.filter((reply) => reply.body.includes('Hello from the stub'))).toHaveLength(1)
    expect(streamedText(frames)).toBe(
      `[t1] permission:allow-always Hello from the stub (model ${model}, mode bypassPermissions).`,
    )

    const [launch] = relay.created as { agent: Record<string, unknown>; secrets: object }[]
    expect(relay.created).toHaveLength(1)
    expect(launch?.agent).not.toHaveProperty('kind')
    expect(JSON.stringify(launch)).not.toMatch(/BASE_URL|API_KEY|ANTHROPIC_MODEL|base_url/)
    expect(launch?.secrets).toEqual({})

    const environmentQuestion = await prompt(chat, 'stub:env')
    const [, environment] = /env:(\[.*?\])/.exec((await finished(environmentQuestion, chat))[0]?.body ?? '') ?? []
    expect(environment).toBeDefined()
    expect(environment).not.toMatch(/BASE_URL|API_KEY|TOKEN|ANTHROPIC|OPENAI/)

    const live = await messagesOf(chat)
    await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
    expect(await messagesOf(chat)).toEqual(live)
  },
)

test('thinking streams as reasoning, then is stored as one thought with its duration', async () => {
  await machine()
  const chat = await newMachineChat()
  const frames = await stack.subscribedFrames(chat)
  const replies = await finished(await prompt(chat, 'stub:think'), chat)

  expect(streamedText(frames, true)).toBe('Thinking about the plan.')
  expect(replies).toHaveLength(2)
  expect(replies[0]).toMatchObject({
    kind: 'step',
    step: { type: 'thought', text: 'Thinking about the plan.', durationMilliseconds: expect.any(Number) },
  })
  expect(replies[1]?.kind).toBe('agent')
})

test('Stop closes the turn as stopped, and the next prompt continues the same ACP session', async () => {
  const relay = await machine()
  const chat = await newMachineChat()
  const stopped = await prompt(chat, 'stub:long')
  await stack.commandShown(stopped)
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await waitFor(async () => (await turnOf(chat)) === null)
  const stoppedReplies = await repliesTo(stopped)
  expect(stoppedReplies.find((reply) => reply.kind === 'step')?.step).toMatchObject({
    type: 'command',
    command: 'sleep 600',
    exitCode: null,
  })
  expect(stoppedReplies.at(-1)).toMatchObject({ kind: 'notice', body: 'Stopped by Alice' })

  const next = await prompt(chat, 'Carry on')
  const replies = await finished(next, chat)
  expect(replies.at(-1)?.body).toContain('[t2] ')
  expect(bodiesOf(replies).some((body) => body.includes('new session'))).toBe(false)
  expect(relay.created).toHaveLength(1)
  const sessions = (await storedAgentEventsOf(chat)).filter(
    (event) =>
      (event.payload as { event: { update: { sessionUpdate: string } } }).event.update.sessionUpdate ===
      'session_started',
  )
  expect(sessions).toHaveLength(1)
})

test('a socket dropped mid-turn resumes after the last stored seq: no event lost, none stored or streamed twice', async () => {
  const relay = await machine({ gapMilliseconds: 250 })
  const chat = await newMachineChat()
  const frames = await stack.subscribedFrames(chat)
  const question = await prompt(chat, 'stub:tools')
  await waitFor(async () => (await repliesTo(question)).some((reply) => reply.body === 'file'))
  relay.dropSockets()
  const replies = await finished(question, chat)

  expect(bodiesOf(replies)).toEqual(toolsReplies)
  expect(relay.socketPaths).toHaveLength(2)
  expect(relay.socketPaths[1]).toMatch(/\?after=[1-9]\d*$/)
  const ids = (await storedAgentEventsOf(chat)).map((event) => event.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(streamedText(frames)).toBe(
    '[t1] permission:allow-always Hello from the stub (model stub-default, mode bypassPermissions).',
  )
})

test('the adapter’s models list in the routing read, and a pick is switched in place at the next prompt', async () => {
  const relay = await machine()
  const chat = await newMachineChat()
  await finished(await prompt(chat, 'Hello'), chat)
  expect(await routingOf(chat)).toEqual({
    currentModelId: 'stub-default',
    available: [
      { id: 'stub-default', name: 'Default (stub)' },
      { id: 'stub-large', name: 'Large (stub)' },
    ],
  })

  expect(
    await mutate(aliceInAcme, 'conversation.updateChatRouting', {
      workspaceId: acme,
      chatId: chat,
      adapterModel: 'stub-large',
    }),
  ).toEqual(succeeded)
  const replies = await finished(await prompt(chat, 'Again'), chat)
  expect(replies.at(-1)?.body).toContain('model stub-large')
  expect(relay.created).toHaveLength(1)
  await waitFor(async () => (await routingOf(chat)).currentModelId === 'stub-large')
})

test.each([
  {
    harness: 'claude-code',
    launched: 'default',
    levels: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    picked: 'max',
  },
  {
    harness: 'codex',
    launched: 'low',
    levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    picked: 'high',
  },
])(
  'a $harness effort: the routing read lists the tool’s levels, only the owner picks one, and it is set on the same session at the next prompt only',
  async ({ harness, launched, levels, picked }) => {
    const relay = await machine({ signedIn: [harness] })
    const chat = await newRuntimeChat({ harness, participants: [{ memberId: bob, roleId: 'editor' }] })
    await finished(await prompt(chat, 'Hello'), chat)
    expect((await routingReadOf(chat)).adapterEfforts).toEqual({
      current: launched,
      available: levels.map((id) => ({ id, name: id })),
    })
    const setEffort = (member: typeof aliceInAcme, reasoningEffort: string) =>
      mutate(member, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, reasoningEffort })
    expect(await setEffort(bobInAcme, picked)).toEqual(failedWith('Only the owner changes how this session runs'))
    expect(await setEffort(aliceInAcme, picked)).toEqual(succeeded)
    const replies = await finished(await prompt(chat, 'stub:effort'), chat)
    expect(replies.at(-1)?.body).toStartWith(`[t2] Effort ${picked}. `)
    await finished(await prompt(chat, 'Again'), chat)
    expect(relay.modelSwitches).toEqual([undefined])
    expect(relay.thoughtLevels).toEqual([picked])
    expect(relay.created).toHaveLength(1)
    await waitFor(async () => (await routingReadOf(chat)).adapterEfforts.current === picked)
  },
)

test('a late chunk of a stopped turn does not land in the next turn', async () => {
  await machine({ gapMilliseconds: 250 })
  const chat = await newMachineChat()
  const frames = await stack.subscribedFrames(chat)
  const stopped = await prompt(chat, 'stub:long stub:late')
  await stack.commandShown(stopped)
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  const next = await prompt(chat, 'stub:tools')
  const replies = await finished(next, chat)

  expect(bodiesOf(replies)).toEqual(toolsReplies.map((body) => body.replace('[t1]', '[t2]')))
  expect(streamedText(frames)).not.toContain('LATE')
  expect((await messagesOf(chat)).some((message) => message.body.includes('LATE'))).toBe(false)
})

test.each([
  { harness: 'claude-code', name: 'Claude Code' },
  { harness: 'codex', name: 'Codex' },
])(
  'an expired $name login ends the turn with one sign-in error and no agent message, and the tool stays signed out until its credentials change',
  async ({ harness, name }) => {
    const { host } = await stack.agentHost('Machine', { ownerId: alice, signedIn: [harness] })
    const chat = await newRuntimeChat({ harness })
    const frames = await stack.subscribedFrames(chat)
    const expired = await prompt(chat, 'stub:auth-expired')
    await waitFor(async () => (await repliesTo(expired)).length > 0)
    await waitFor(async () => (await turnOf(chat)) === null)
    const signedIn = async () =>
      (await database.$client`select capacity->'signedIn' as "signedIn" from runtime_hosts where id = ${host.id}`)[0]
        ?.signedIn
    const reconnect = async () => {
      await host.disconnect()
      await host.connect()
    }

    expect(streamedText(frames)).toBe('OAuth session expired and could not be refreshed.')
    expect(await repliesTo(expired)).toEqual([
      {
        kind: 'step',
        body: 'error',
        step: { type: 'error', message: `Authentication required — sign in to ${name} again`, signIn: harness },
      },
    ])
    expect(await signedIn()).toEqual([])
    await reconnect()
    expect(await signedIn()).toEqual([])
    const refused = await prompt(chat, 'Hello')
    await waitFor(async () => (await repliesTo(refused)).length > 0)
    expect(bodiesOf(await repliesTo(refused))).toEqual([
      `notice:Sign in to ${name} on your machine: docker exec -it spyria-host spyria-host login ${harness}`,
    ])

    host.signIn([harness])
    await reconnect()
    expect(await signedIn()).toEqual([harness])
    expect(bodiesOf(await finished(await prompt(chat, 'Hello'), chat))).toEqual([
      expect.stringContaining('agent:[t2] Hello from the stub'),
    ])
  },
)

test('a start that fails closes the turn at once with the adapter message and does not retry', async () => {
  const relay = await machine({ startFails: true })
  const chat = await newMachineChat()
  const question = await prompt(chat, 'Hello')
  await waitFor(async () => (await repliesTo(question)).length > 0)
  await waitFor(async () => (await turnOf(chat)) === null)

  expect(bodiesOf(await repliesTo(question))).toEqual(['notice:The agent could not start: Authentication required'])
  await stack.jobDone('agent.prompt', { messageId: question })
  expect(relay.created).toHaveLength(1)
  expect(await repliesTo(question)).toHaveLength(1)
})

test('a plan update shows as a plan step and replaces the Plan tab rows, and a Task call with its inner calls as one subagent group', async () => {
  await machine()
  const chat = await newMachineChat()
  const planned = await finished(await prompt(chat, 'stub:plan'), chat)
  expect(planned[1]?.step).toEqual({
    type: 'plan',
    items: [
      { title: 'Write tests', status: 'done' },
      { title: 'Fix the bug', status: 'in-progress' },
      { title: 'Ship', status: 'todo' },
    ],
  })
  expect([
    ...(await database.$client`select title, status from plan_steps where chat_id = ${chat} order by position`),
  ]).toEqual([
    { title: 'Write tests', status: 'done' },
    { title: 'Fix the bug', status: 'in-progress' },
    { title: 'Ship', status: 'todo' },
  ])

  const replies = await finished(await prompt(chat, 'stub:subagent'), chat)
  const [, host, child] = replies
  expect(host?.step).toMatchObject({ type: 'tool', name: 'Task', result: 'Two files.' })
  expect(child?.step).toMatchObject({
    type: 'command',
    command: 'ls',
    output: 'a.ts',
    delegation: { id: expect.stringMatching(/:task-2$/) },
  })
})

const chooseRunsOn = (chat: ChatId, runsOn: string, user = aliceInAcme) =>
  mutate(user, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, runsOn })
const sessionFieldsOf = async (chat: ChatId) =>
  (await database.$client`select harness, local_session from chats where id = ${chat}`)[0]
const startJobsOf = async (chat: ChatId) =>
  database.$client<{ state: string }[]>`
    select state from jobs where type = 'agent.start-session' and payload->>'chatId' = ${chat}`
const startedEventsOf = async (chat: ChatId) =>
  (await storedAgentEventsOf(chat)).filter(
    (event) =>
      (event.payload as { event?: { update?: { sessionUpdate?: string } } }).event?.update?.sessionUpdate ===
      'session_started',
  )

test.each([{ harness: 'claude-code' }, { harness: 'codex' }])(
  'choosing $harness on the machine starts the session once with no prompt, and the first prompt joins it',
  async ({ harness }) => {
    const relay = await machine({ signedIn: [harness] })
    const chat = await newRuntimeChat()
    expect(await chooseRunsOn(chat, harness)).toEqual(succeeded)
    await waitFor(async () => (await startedEventsOf(chat)).length === 1)
    expect(relay.created).toHaveLength(1)
    expect((relay.created[0] as { agent: object }).agent).not.toHaveProperty('acp_model')
    expect(relay.prompts).toHaveLength(0)
    expect(await chooseRunsOn(chat, 'runtime')).toEqual(
      failedWith('This session has started; where it runs no longer changes'),
    )
    expect(await sessionFieldsOf(chat)).toEqual({ harness, local_session: true })

    await finished(await prompt(chat, 'Hello'), chat)
    expect(relay.created).toHaveLength(1)
    expect(await startedEventsOf(chat)).toHaveLength(1)
    await waitFor(async () => (await startJobsOf(chat)).every(({ state }) => state === 'done'))
  },
)

test('nothing starts for a signed-out tool, a non-owner or a choice of the Spyria runtime', async () => {
  const relay = await machine({ signedIn: [] })
  const signedOut = await newRuntimeChat()
  expect(await chooseRunsOn(signedOut, defaultHarness)).toEqual(succeeded)
  await waitFor(async () => (await startJobsOf(signedOut)).every(({ state }) => state === 'done'))
  expect(relay.created).toHaveLength(0)

  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  expect(await chooseRunsOn(chat, defaultHarness, bobInAcme)).toEqual(
    failedWith('Only the owner changes how this session runs'),
  )
  expect(await sessionFieldsOf(chat)).toEqual({ harness: null, local_session: false })
  expect(await chooseRunsOn(chat, 'runtime')).toEqual(succeeded)
  expect(await startJobsOf(chat)).toHaveLength(0)
})

test('a prompt sent at once after the choice joins the one session and streams live to a viewer subscribed before the chat was stored', async () => {
  const relay = await machine({ gapMilliseconds: 30 })
  const chat = chatId(`chat-${crypto.randomUUID()}`)
  const { frames, subscribed } = await stack.openStream(chat)
  await Bun.sleep(subscribeBeforeStoredMilliseconds)
  await newRuntimeChat({ id: chat })
  await subscribed
  expect(await chooseRunsOn(chat, defaultHarness)).toEqual(succeeded)
  const replies = await finished(await prompt(chat, 'stub:think'), chat)
  expect(replies.at(-1)?.kind).toBe('agent')
  expect(streamedText(frames, true)).toBe('Thinking about the plan.')
  expect(relay.created).toHaveLength(1)
  expect(await startedEventsOf(chat)).toHaveLength(1)
})

test('before the owner chooses, a member’s prompt is refused with the waiting notice; on the machine, it gets the owner-only notice and never reaches the agent', async () => {
  const relay = await machine()
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  await database.$client`update chats set local_session = null where id = ${chat}`
  const sneaking = { workspaceId: acme, id: `message-${crypto.randomUUID()}`, chatId: chat, text: 'Sneaking in' }
  expect(await mutate(bobInAcme, 'conversation.sendMessage', sneaking)).toEqual(
    failedWith('Waiting for Alice to choose where this chat runs'),
  )
  expect(await messagesOf(chat)).toEqual([])

  expect(await chooseRunsOn(chat, defaultHarness)).toEqual(succeeded)
  await finished(await prompt(chat, 'Alice prompts'), chat)
  expect(bodiesOf(await repliesTo(await prompt(chat, 'Bob tries', bobInAcme)))).toEqual([
    'notice:Only the owner prompts a session on their machine',
  ])
  expect(relay.prompts).toEqual(['Alice prompts'])
})

const machineLosingFirstCreate = async () => {
  const createReached = Promise.withResolvers<void>()
  const { relay, host } = await stack.agentHost('Machine', {
    ownerId: alice,
    signedIn: [defaultHarness],
    containerAgentOf: (relay) => ({
      ...relay.containerAgent,
      respond: async (request, container) => {
        const response = await relay.containerAgent.respond(request, container)
        if (request.method !== 'POST' || request.path !== '/api/conversations' || relay.created.length > 1)
          return response
        createReached.resolve()
        return new Promise(() => {})
      },
    }),
  })
  return { relay, host, createReached: createReached.promise }
}

test('a session start whose answer is lost to a host reconnect keeps its one conversation, and the first prompt joins it', async () => {
  const { relay, host, createReached } = await machineLosingFirstCreate()
  const chat = await newRuntimeChat()
  expect(await chooseRunsOn(chat, defaultHarness)).toEqual(succeeded)
  await createReached
  await host.disconnect()
  await host.connect()
  const replies = await finished(await prompt(chat, 'Hello'), chat)

  expect(replies.at(-1)?.body).toContain('[t1] ')
  expect(relay.adapterLaunches()).toEqual([defaultHarness])
  expect(await startedEventsOf(chat)).toHaveLength(1)
  await waitFor(async () => (await startJobsOf(chat)).every(({ state }) => state === 'done'))
})

test('the machine going offline while its runtime starts shows "Your machine is offline", not a start failure', async () => {
  const { relay, host } = await stack.agentHost('Machine', { ownerId: alice, signedIn: [defaultHarness] })
  host.hold('start')
  const chat = await newRuntimeChat()
  expect(await chooseRunsOn(chat, defaultHarness)).toEqual(succeeded)
  const question = await prompt(chat, 'Hello')
  await waitFor(async () => host.commands.some(({ op }) => op === 'start'))
  await host.disconnect()
  await waitFor(async () => (await repliesTo(question)).length > 0)

  expect(bodiesOf(await repliesTo(question))).toEqual(['notice:Your machine is offline'])
  expect(relay.adapterLaunches()).toEqual([])

  await host.connect()
  await stack.agentBridge.forDatabase(database).resumeHost({ workspaceId: acme, hostId: runtimeHostId(host.id) })
  expect((await finished(question, chat)).at(-1)?.body).toContain('[t1] ')
  expect(relay.adapterLaunches()).toEqual([defaultHarness])
})
