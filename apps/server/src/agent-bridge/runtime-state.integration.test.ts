import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import type { ChatId } from '@spyria/kernel'
import type { createSpyriaAgentRelay } from '../testing/spyria-agent-relay.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  type ContainerAgent,
  globex,
  missingPermission,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing/testing.ts'

setDefaultTimeout(30_000)
const minute = 60_000
let clockOffsetMilliseconds = 0
const {
  database,
  agentBridge,
  mutate,
  newRuntimeChat,
  prompt,
  turnOf,
  turnIs,
  repliesTo,
  answered,
  runtimeOf,
  storedAgentEventsOf,
  holds,
  holdUrl,
  jobStatesOf,
  jobDone,
  ...stack
} = await startAgentStack({
  llm: { model: 'openai/fake' },
  now: () => Date.now() + clockOffsetMilliseconds,
  promptsWaitingAfterHello: true,
})
afterEach(() => {
  clockOffsetMilliseconds = 0
})

const aliceInGlobex = { workspaceId: globex, userId: alice }
type Relay = ReturnType<typeof createSpyriaAgentRelay>
const agentHost = (name = 'Agent host', containerAgentOf?: (relay: Relay) => ContainerAgent) =>
  stack.agentHost(name, { holdUrl, containerAgentOf })
const command = (member: typeof aliceInAcme, name: string, chat: ChatId, workspaceId: string = member.workspaceId) =>
  mutate(member, `conversation.${name}`, { workspaceId, chatId: chat })
const firstTurnMilliseconds = 20_000
const delivered = (relay: Relay, count: number) => waitFor(() => relay.prompts.length >= count, firstTurnMilliseconds)
const commandShown = (messageId: string) => stack.commandShown(messageId, firstTurnMilliseconds)
const conversationIdOf = async (chat: ChatId) => String((await runtimeOf(chat)).agent_conversation_id)
const conversationPath = /^\/api\/conversations\/[^/]+$/
const interruptJobsOf = (chat: ChatId) => jobStatesOf('agent.interrupt', { chatId: chat })
const offlineReopenMilliseconds = 200
const sweepAgentTurns = () =>
  agentBridge.forDatabase(database).jobs['agent.sweep']({ workspaceId: acme, payload: {}, isLastAttempt: false })
const agentReply = (turn: number) => ({
  kind: 'agent' as const,
  body: `[t${turn}] Hello from the stub (model spyria/fake, mode default).`,
})
const notice = (body: string) => ({ kind: 'notice' as const, body })
const stoppedEarly = notice('The agent stopped before finishing')
const noticesOf = async (messageId: string) => (await repliesTo(messageId)).filter((reply) => reply.kind === 'notice')
const endsWith = async (messageId: string, body: string) => {
  expect((await repliesTo(messageId)).at(-1)).toEqual(notice(body))
  expect(await noticesOf(messageId)).toEqual([notice(body)])
}

test('Stop interrupts the agent, ends the turn once with a notice naming the member, then the next prompt runs', async () => {
  const { relay } = await agentHost()
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'editor' }] })
  const first = await prompt(chat, 'stub:long Take your time')
  await commandShown(first)
  const second = await prompt(chat, 'Then this')

  expect(await command(aliceInGlobex, 'stopAgent', chat)).toEqual(missingPermission('session.configure'))
  expect(await command(aliceInGlobex, 'stopAgent', chat, acme)).not.toEqual(succeeded)
  expect(await interruptJobsOf(chat)).toEqual([])
  expect(relay.interrupts).toEqual([])
  expect(await turnOf(chat)).toBe(first)

  expect(await command(bobInAcme, 'stopAgent', chat)).toEqual(succeeded)
  await answered(second)
  await jobDone('agent.interrupt', { chatId: chat })
  expect(relay.interrupts).toEqual([await conversationIdOf(chat)])
  await endsWith(first, 'Stopped by Bob')
  expect(await repliesTo(second)).toEqual([agentReply(2)])
  expect(relay.prompts).toEqual(['stub:long Take your time', 'Then this'])
  await turnIs(chat, null)
  expect(await command(bobInAcme, 'stopAgent', chat)).toEqual(succeeded)
  expect(await interruptJobsOf(chat)).toEqual(['done'])
  expect(relay.interrupts).toHaveLength(1)
})

test('a prompt whose turn was stopped while it was being sent is interrupted at once', async () => {
  let firstPromptId = ''
  const { relay } = await agentHost('Agent host', (relay) => ({
    ...relay.containerAgent,
    respond: async (request, container) => {
      if (request.method === 'POST' && request.path.endsWith('/events'))
        await database.$client`update chats set agent_turn_message_id = null where agent_turn_message_id = ${firstPromptId}`
      return relay.containerAgent.respond(request, container)
    },
  }))
  const chat = await newRuntimeChat()
  firstPromptId = await prompt(chat, 'stub:long Stopped before sent')
  await delivered(relay, 1)

  await waitFor(() => relay.interrupts.length === 1)
  expect(relay.interrupts).toEqual([await conversationIdOf(chat)])
})

test('a Stop whose interrupt arrives after the turn already finished ends the turn once', async () => {
  let first = ''
  const interruptSent = Promise.withResolvers<void>()
  const { relay } = await agentHost('Agent host', (relay) => ({
    ...relay.containerAgent,
    respond: async (request, container) => {
      if (!request.path.endsWith('/interrupt')) return relay.containerAgent.respond(request, container)
      interruptSent.resolve()
      await waitFor(async () => (await turnOf(chat)) !== first)
      return { status: 200, body: '{}' }
    },
  }))
  const chat = await newRuntimeChat()
  first = await prompt(chat, 'stub:linger Almost done')
  await turnIs(chat, first)
  await delivered(relay, 1)
  const second = await prompt(chat, 'Next one')

  expect(await command(aliceInAcme, 'stopAgent', chat)).toEqual(succeeded)
  await interruptSent.promise
  await holds.release('linger')
  await answered(second)
  await turnIs(chat, null)
  await jobDone('agent.interrupt', { chatId: chat })
  const firstReplies = (await repliesTo(first)).map((reply) => reply.body)
  expect(firstReplies.length).toBeGreaterThan(0)
  expect(firstReplies.filter((body) => body === 'Stopped by Alice').length).toBeLessThanOrEqual(1)
  expect(firstReplies).not.toContain('The agent finished without a reply')
  expect(await repliesTo(second)).toEqual([agentReply(2)])
  expect(relay.prompts).toEqual(['stub:linger Almost done', 'Next one'])
})

test('a prompt whose conversation create keeps failing ends with "could not start" after its last attempt, and the next prompt runs', async () => {
  let isCreateFailing = true
  await agentHost('Agent host', (relay) => ({
    ...relay.containerAgent,
    respond: async (request, container) =>
      isCreateFailing && request.method === 'POST' && request.path === '/api/conversations'
        ? { status: 500, body: '{}' }
        : relay.containerAgent.respond(request, container),
  }))
  const chat = await newRuntimeChat()
  const failed = await prompt(chat, 'Start please')
  await waitFor(async () => (await noticesOf(failed)).length > 0, firstTurnMilliseconds)
  expect(await repliesTo(failed)).toEqual([
    notice('The agent could not start: spyria-agent answered POST /api/conversations with 500'),
  ])
  await turnIs(chat, null)

  isCreateFailing = false
  const next = await prompt(chat, 'Then this')
  await answered(next)
  expect(await repliesTo(next)).toEqual([agentReply(1)])
  expect(await repliesTo(failed)).toHaveLength(1)
})

test('Retry replaces a failed runtime and answers the waiting prompts in order; refused unless failed or from another workspace', async () => {
  const { host: failingHost } = await agentHost('Failing host')
  failingHost.failing('create')
  const chat = await newRuntimeChat({ participants: [{ memberId: bob, roleId: 'prompter' }] })
  const first = await prompt(chat, 'First waiting')
  await answered(first)
  const second = await prompt(chat, 'Second waiting')
  await answered(second)
  expect(await repliesTo(first)).toEqual([notice('The agent could not start')])
  expect(await repliesTo(second)).toEqual([notice('The agent could not start')])
  const failed = await runtimeOf(chat)
  expect(failed).toMatchObject({ state: 'failed', failure: 'create_failed' })
  await failingHost.disconnect()
  const { relay } = await agentHost('Healthy host')

  expect(await command(aliceInGlobex, 'retryAgent', chat)).not.toEqual(succeeded)
  expect(await command(aliceInGlobex, 'retryAgent', chat, acme)).not.toEqual(succeeded)
  expect(await runtimeOf(chat)).toMatchObject({ id: failed?.id, state: 'failed' })

  expect(await command(bobInAcme, 'retryAgent', chat)).toEqual(succeeded)
  await answered(second, 2)
  expect((await runtimeOf(chat))?.id).not.toBe(failed?.id)
  expect(await runtimeOf(chat)).toMatchObject({ state: 'running', failure: null })
  expect(relay.prompts).toEqual(['First waiting', 'Second waiting'])
  expect(await repliesTo(first)).toEqual([notice('The agent could not start'), agentReply(1)])
  expect(await repliesTo(second)).toEqual([notice('The agent could not start'), agentReply(2)])
  expect(await command(aliceInAcme, 'retryAgent', chat)).not.toEqual(succeeded)
  expect((await runtimeOf(chat))?.state).toBe('running')
})

test('a turn ends with a notice when its runtime stops, its host stays offline past the silence bound or its host is removed', async () => {
  const { relay, host } = await agentHost()
  const stopping = await newRuntimeChat()
  const stopped = await prompt(stopping, 'stub:long Keep working')
  await commandShown(stopped)
  await database.$client`update runtimes set state = 'stopped', state_changed_at = now() where chat_id = ${stopping}`
  relay.dropSockets()
  await turnIs(stopping, null)
  await endsWith(stopped, stoppedEarly.body)

  const losing = await newRuntimeChat()
  const lost = await prompt(losing, 'stub:long Keep working')
  await commandShown(lost)
  await host.disconnect()
  await Bun.sleep(offlineReopenMilliseconds)
  expect(await turnOf(losing)).toBe(lost)
  clockOffsetMilliseconds = 11 * minute
  await sweepAgentTurns()
  await endsWith(lost, stoppedEarly.body)
  expect(await turnOf(losing)).toBeNull()
  clockOffsetMilliseconds = 0

  await host.connect()
  const removing = await newRuntimeChat()
  const removed = await prompt(removing, 'stub:long Keep working')
  await commandShown(removed)
  expect(await mutate(aliceInAcme, 'runtime.removeHost', { workspaceId: acme, hostId: host.id })).toEqual(succeeded)
  await turnIs(removing, null)
  await endsWith(removed, stoppedEarly.body)
})

test('the sweep keeps a silent turn spyria-agent still runs and touches its runtime, ends a silent turn spyria-agent finished and turns whose runtime is not running, and reschedules itself', async () => {
  await agentHost()
  const silent = await newRuntimeChat()
  const silentPrompt = await prompt(silent, 'stub:long Stay silent')
  await commandShown(silentPrompt)
  await database.$client`update runtimes set last_active_at = now() - interval '2 hours' where chat_id = ${silent}`
  const finishing = await newRuntimeChat()
  const finished = await prompt(finishing, 'Finish without a turn end')
  await answered(finished)
  await turnIs(finishing, null)
  await database.$client`update chats set agent_turn_message_id = ${finished} where id = ${finishing}`
  const notRunning = await newRuntimeChat()
  const notRunningPrompt = await prompt(notRunning, 'stub:long Stay silent')
  await commandShown(notRunningPrompt)
  await database.$client`update runtimes set state = 'stopped', state_changed_at = now() where chat_id = ${notRunning}`

  clockOffsetMilliseconds = 9 * minute
  await sweepAgentTurns()
  expect(await turnOf(silent)).toBe(silentPrompt)
  expect(await turnOf(finishing)).toBe(finished)
  await endsWith(notRunningPrompt, stoppedEarly.body)
  expect(await turnOf(notRunning)).toBeNull()

  clockOffsetMilliseconds = 11 * minute
  await sweepAgentTurns()
  expect(await turnOf(silent)).toBe(silentPrompt)
  expect(Date.now() - new Date((await runtimeOf(silent)).last_active_at).getTime()).toBeLessThan(minute)
  await endsWith(finished, 'The agent did not respond')
  expect(await turnOf(finishing)).toBeNull()
  const sweeps = await database.$client`
    select extract(epoch from run_at - now()) as delay_seconds from jobs where type = 'agent.sweep' and state = 'queued'`
  expect(sweeps).toHaveLength(1)
  expect(Number(sweeps[0]?.delay_seconds)).toBeGreaterThan(50)
})

test('a host blip during a turn keeps the turn, which ends with its reply once the host is back', async () => {
  const { host } = await agentHost()
  const chat = await newRuntimeChat()
  const held = await prompt(chat, 'stub:linger Through the blip')
  await holds.reached('linger')
  await host.disconnect()
  await Bun.sleep(offlineReopenMilliseconds)
  expect(await turnOf(chat)).toBe(held)

  await host.connect()
  await holds.release('linger')
  await turnIs(chat, null)
  expect(await repliesTo(held)).toEqual([agentReply(1)])
})

test("a turn end arriving after its turn was closed does not end the next prompt's turn", async () => {
  let isStatusHidden = false
  let isFirstEnded = Promise.resolve()
  const turnEndsOf = async (chat: ChatId) =>
    (await storedAgentEventsOf(chat)).filter(
      (event) =>
        (event.payload as { event: { update: { sessionUpdate?: string } } }).event.update.sessionUpdate === 'turn_end',
    ).length
  const { relay } = await agentHost('Agent host', (relay) => ({
    ...relay.containerAgent,
    respond: async (request, container) => {
      if (isStatusHidden && request.method === 'GET' && conversationPath.test(request.path))
        return { status: 503, body: '' }
      if (request.path.endsWith('/events') && relay.prompts.length === 1) await isFirstEnded
      return relay.containerAgent.respond(request, container)
    },
  }))
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'stub:linger Slow first')
  await holds.reached('linger')
  isStatusHidden = true
  clockOffsetMilliseconds = 11 * minute
  await sweepAgentTurns()
  clockOffsetMilliseconds = 0
  isStatusHidden = false
  await endsWith(first, 'The agent did not respond')

  isFirstEnded = waitFor(async () => (await turnEndsOf(chat)) === 1).then(() => {})
  const second = await prompt(chat, 'Then this')
  await turnIs(chat, second)
  await holds.release('linger')
  await isFirstEnded
  expect(await turnOf(chat)).toBe(second)
  await answered(second)
  await turnIs(chat, null)
  expect(await repliesTo(second)).toEqual([agentReply(2)])
  expect(await repliesTo(first)).toEqual([notice('The agent did not respond')])
  expect(relay.prompts).toEqual(['stub:linger Slow first', 'Then this'])
})

test('on reconnect, a turn spyria-agent finished while away is closed from the resent events, and a turn whose conversation is gone ends with a notice', async () => {
  let isHoldingStatus = false
  const { relay } = await agentHost('Agent host', (relay) => ({
    ...relay.containerAgent,
    respond: async (request, container) => {
      const isStatus = request.method === 'GET' && conversationPath.test(request.path)
      if (isHoldingStatus && isStatus)
        await waitFor(
          async () =>
            JSON.parse(String(((await relay.containerAgent.respond(request, container)) as { body: string }).body))
              .execution_status === 'finished',
        )
      return relay.containerAgent.respond(request, container)
    },
  }))
  const finishing = await newRuntimeChat()
  const finished = await prompt(finishing, 'stub:linger Finish while away')
  await turnIs(finishing, finished)
  await delivered(relay, 1)
  isHoldingStatus = true
  relay.dropSockets()
  await holds.release('linger')
  await turnIs(finishing, null)
  isHoldingStatus = false
  expect(await repliesTo(finished)).toEqual([agentReply(1)])

  const losing = await newRuntimeChat()
  const lost = await prompt(losing, 'stub:long Lose the conversation')
  await commandShown(lost)
  await relay.restart()
  await turnIs(losing, null)
  await endsWith(lost, stoppedEarly.body)
})

test('runtimes.host_online follows its host through hello and offline', async () => {
  const { host } = await agentHost()
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Start'))
  expect(await runtimeOf(chat)).toMatchObject({ state: 'running', host_online: true })
  await host.disconnect()
  expect(await runtimeOf(chat)).toMatchObject({ state: 'running', host_online: false })
  await host.connect()
  expect(await runtimeOf(chat)).toMatchObject({ state: 'running', host_online: true })
})

test('a prompt while the host is offline gets one notice and is answered after the host says hello again', async () => {
  const { relay, host } = await agentHost()
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Warm up'))
  await turnIs(chat, null)
  await host.disconnect()

  const waiting = await prompt(chat, 'Are you there?')
  await answered(waiting)
  await jobDone('agent.prompt', { messageId: waiting })
  expect(await repliesTo(waiting)).toEqual([notice('The runtime host is offline')])
  expect(await turnOf(chat)).toBeNull()

  await host.connect()
  await answered(waiting, 2)
  expect(await repliesTo(waiting)).toEqual([notice('The runtime host is offline'), agentReply(2)])
  expect(relay.prompts).toEqual(['Warm up', 'Are you there?'])
})
