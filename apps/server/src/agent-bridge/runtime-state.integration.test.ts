import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import type { ChatId } from '@hq/kernel'
import { acme, alice, aliceInAcme, globex, bobInAcme, startAgentStack, succeeded, waitFor } from '../testing.ts'
import { type Conversation, createFakeAgentServer, type FakeAgent, replyText } from './fake-agent-server.ts'

setDefaultTimeout(30_000)
const minute = 60_000
let clockOffsetMilliseconds = 0
const {
  database,
  agentBridge,
  fakeHost,
  mutate,
  newRuntimeChat,
  prompt,
  turnOf,
  turnIs,
  repliesTo,
  answered,
  runtimeOf,
} = await startAgentStack({
  llm: { model: 'openai/fake' },
  now: () => Date.now() + clockOffsetMilliseconds,
  promptsWaitingAfterHello: true,
})
afterEach(() => {
  clockOffsetMilliseconds = 0
})

const aliceInGlobex = { workspaceId: globex, userId: alice }
const agentHost = async (name = 'Agent host') => {
  const fake = createFakeAgentServer()
  return { fake, host: await fakeHost(name, { agentServer: fake.agentServer }) }
}
const holdTurnsOf = (fake: FakeAgent, heldPrompt: string) => {
  const defaultTurn = fake.turn
  fake.turn = async (conversation, promptText) => {
    if (promptText !== heldPrompt) return defaultTurn(conversation, promptText)
    await fake.beginTurn(conversation, promptText)
  }
}
const command = (member: typeof aliceInAcme, name: string, chat: ChatId, workspaceId: string = member.workspaceId) =>
  mutate(member, `conversation.${name}`, { workspaceId, chatId: chat })
const replyBodiesOf = async (messageId: string) => (await repliesTo(messageId)).map((reply) => reply.body)
const delivered = (fake: FakeAgent, count: number) => waitFor(() => fake.prompts.length >= count)
const conversationOf = (fake: FakeAgent) => [...fake.conversations.values()].at(-1) as Conversation
const closeEventSockets = (conversation: Conversation) => {
  for (const close of conversation.closers) close()
}
const sweepAgentTurns = () => agentBridge.forDatabase(database).jobs['agent.sweep']({ workspaceId: acme, payload: {} })
const agentReply = { kind: 'agent' as const, body: replyText }
const notice = (body: string) => ({ kind: 'notice' as const, body })
const stoppedEarly = notice('The agent stopped before finishing')

test('Stop interrupts the agent, ends the turn once with a notice naming the member, then the next prompt runs', async () => {
  const { fake } = await agentHost()
  holdTurnsOf(fake, 'Take your time')
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'Take your time')
  await turnIs(chat, first)
  const second = await prompt(chat, 'Then this')

  expect(await command(aliceInGlobex, 'stopAgent', chat)).toEqual(succeeded)
  expect(await command(aliceInGlobex, 'stopAgent', chat, acme)).not.toEqual(succeeded)
  await Bun.sleep(200)
  expect(fake.interrupts).toEqual([])
  expect(await turnOf(chat)).toBe(first)

  expect(await command(bobInAcme, 'stopAgent', chat)).toEqual(succeeded)
  await answered(second)
  expect(fake.interrupts).toEqual([conversationOf(fake).id])
  expect(await repliesTo(first)).toEqual([notice('Stopped by Bob')])
  expect(await repliesTo(second)).toEqual([agentReply])
  expect(fake.prompts.map((delivered) => delivered.text)).toEqual(['Take your time', 'Then this'])
  await turnIs(chat, null)
  expect(await command(bobInAcme, 'stopAgent', chat)).toEqual(succeeded)
  await Bun.sleep(200)
  expect(fake.interrupts).toHaveLength(1)
})

test('a prompt whose turn was stopped while it was being sent is interrupted at once', async () => {
  const fake = createFakeAgentServer()
  await fakeHost('Agent host', {
    agentServer: {
      ...fake.agentServer,
      respond: async (request, container) => {
        if (request.method === 'POST' && request.path.endsWith('/events'))
          await database.$client`update chats set agent_turn_message_id = null where agent_turn_message_id = ${firstPromptId}`
        return fake.agentServer.respond(request, container)
      },
    },
  })
  holdTurnsOf(fake, 'Stopped before sent')
  const chat = await newRuntimeChat()
  const firstPromptId = await prompt(chat, 'Stopped before sent')
  await delivered(fake, 1)

  await waitFor(() => fake.interrupts.length === 1)
  expect(fake.interrupts).toEqual([conversationOf(fake).id])
})

test('an interrupt racing the finished event ends the turn once', async () => {
  const { fake } = await agentHost()
  holdTurnsOf(fake, 'Almost done')
  fake.onInterrupt = (conversation) => fake.finishTurn(conversation)
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'Almost done')
  await turnIs(chat, first)
  const second = await prompt(chat, 'Next one')

  expect(await command(aliceInAcme, 'stopAgent', chat)).toEqual(succeeded)
  await answered(second)
  await turnIs(chat, null)
  await Bun.sleep(200)
  const firstReplies = await replyBodiesOf(first)
  expect(firstReplies.length).toBeGreaterThan(0)
  expect(firstReplies.filter((body) => body === 'Stopped by Alice').length).toBeLessThanOrEqual(1)
  expect(firstReplies).not.toContain('The agent finished without a reply')
  expect(await repliesTo(second)).toEqual([agentReply])
  expect(fake.prompts.map((delivered) => delivered.text)).toEqual(['Almost done', 'Next one'])
})

test('Retry replaces a failed runtime and answers the waiting prompts in order; refused unless failed or from another workspace', async () => {
  const { host: failingHost } = await agentHost('Failing host')
  failingHost.failing('create')
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'First waiting')
  await answered(first)
  const second = await prompt(chat, 'Second waiting')
  await answered(second)
  expect(await repliesTo(first)).toEqual([notice('The agent could not start')])
  expect(await repliesTo(second)).toEqual([notice('The agent could not start')])
  const failed = await runtimeOf(chat)
  expect(failed).toMatchObject({ state: 'failed', failure: 'create_failed' })
  await failingHost.disconnect()
  const { fake } = await agentHost('Healthy host')

  expect(await command(aliceInGlobex, 'retryAgent', chat)).not.toEqual(succeeded)
  expect(await command(aliceInGlobex, 'retryAgent', chat, acme)).not.toEqual(succeeded)
  expect(await runtimeOf(chat)).toMatchObject({ id: failed?.id, state: 'failed' })

  expect(await command(bobInAcme, 'retryAgent', chat)).toEqual(succeeded)
  await answered(second, 2)
  expect((await runtimeOf(chat))?.id).not.toBe(failed?.id)
  expect(await runtimeOf(chat)).toMatchObject({ state: 'running', failure: null })
  expect(fake.prompts.map((delivered) => delivered.text)).toEqual(['First waiting', 'Second waiting'])
  expect(await repliesTo(first)).toEqual([notice('The agent could not start'), agentReply])
  expect(await repliesTo(second)).toEqual([notice('The agent could not start'), agentReply])
  expect(await command(aliceInAcme, 'retryAgent', chat)).not.toEqual(succeeded)
  expect((await runtimeOf(chat))?.state).toBe('running')
})

test('a turn ends with a notice when its runtime stops, its host goes offline or its host is removed', async () => {
  const { fake, host } = await agentHost()
  holdTurnsOf(fake, 'Keep working')
  const stopping = await newRuntimeChat()
  const stopped = await prompt(stopping, 'Keep working')
  await turnIs(stopping, stopped)
  await delivered(fake, 1)
  await database.$client`update runtimes set state = 'stopped', state_changed_at = now() where chat_id = ${stopping}`
  closeEventSockets(conversationOf(fake))
  await turnIs(stopping, null)
  expect(await repliesTo(stopped)).toEqual([stoppedEarly])

  const losing = await newRuntimeChat()
  const lost = await prompt(losing, 'Keep working')
  await turnIs(losing, lost)
  await delivered(fake, 2)
  await host.disconnect()
  await turnIs(losing, null)
  expect(await repliesTo(lost)).toEqual([stoppedEarly])

  await host.connect()
  const removing = await newRuntimeChat()
  const removed = await prompt(removing, 'Keep working')
  await turnIs(removing, removed)
  await delivered(fake, 3)
  expect(await mutate(aliceInAcme, 'runtime.removeHost', { workspaceId: acme, hostId: host.id })).toEqual(succeeded)
  await turnIs(removing, null)
  expect(await repliesTo(removed)).toEqual([stoppedEarly])
})

test('the sweep ends turns silent for 10 minutes and turns whose runtime is not running, and reschedules itself', async () => {
  const { fake } = await agentHost()
  holdTurnsOf(fake, 'Stay silent')
  const silent = await newRuntimeChat()
  const silentPrompt = await prompt(silent, 'Stay silent')
  await turnIs(silent, silentPrompt)
  const notRunning = await newRuntimeChat()
  const notRunningPrompt = await prompt(notRunning, 'Stay silent')
  await turnIs(notRunning, notRunningPrompt)
  await database.$client`update runtimes set state = 'stopped', state_changed_at = now() where chat_id = ${notRunning}`

  clockOffsetMilliseconds = 9 * minute
  await sweepAgentTurns()
  expect(await turnOf(silent)).toBe(silentPrompt)
  expect(await repliesTo(notRunningPrompt)).toEqual([stoppedEarly])
  expect(await turnOf(notRunning)).toBeNull()

  clockOffsetMilliseconds = 11 * minute
  await sweepAgentTurns()
  expect(await repliesTo(silentPrompt)).toEqual([notice('The agent did not respond')])
  expect(await turnOf(silent)).toBeNull()
  const sweeps = await database.$client`
    select extract(epoch from run_at - now()) as delay_seconds from jobs where type = 'agent.sweep' and state = 'queued'`
  expect(sweeps).toHaveLength(1)
  expect(Number(sweeps[0]?.delay_seconds)).toBeGreaterThan(50)
})

test('on reconnect, a turn the Agent Server already ended is closed, and a running one is resumed', async () => {
  const { fake } = await agentHost()
  holdTurnsOf(fake, 'Finish while away')
  holdTurnsOf(fake, 'Fail while away')
  const finishing = await newRuntimeChat()
  const finished = await prompt(finishing, 'Finish while away')
  await turnIs(finishing, finished)
  await delivered(fake, 1)
  const finishedConversation = conversationOf(fake)
  finishedConversation.executionStatus = 'finished'
  closeEventSockets(finishedConversation)
  await turnIs(finishing, null)
  expect(await repliesTo(finished)).toEqual([notice('The agent finished without a reply')])

  const failing = await newRuntimeChat()
  const failed = await prompt(failing, 'Fail while away')
  await turnIs(failing, failed)
  await delivered(fake, 2)
  const failedConversation = conversationOf(fake)
  failedConversation.executionStatus = 'error'
  closeEventSockets(failedConversation)
  await turnIs(failing, null)
  expect(await repliesTo(failed)).toEqual([notice('The agent stopped with an error')])
})

test('a conversation missing on the Agent Server is replaced by a new one, with the notice recorded once', async () => {
  const { fake } = await agentHost()
  const chat = await newRuntimeChat()
  const first = await prompt(chat, 'Remember 42')
  await answered(first)
  await turnIs(chat, null)
  const lostConversation = conversationOf(fake)
  fake.conversations.delete(lostConversation.id)

  const second = await prompt(chat, 'What was it?')
  await answered(second, 2)
  await turnIs(chat, null)
  const third = await prompt(chat, 'And now?')
  await answered(third)
  await turnIs(chat, null)

  const newSession = notice('The agent started a new session; it does not remember earlier messages')
  expect(await repliesTo(second)).toEqual([newSession, agentReply])
  expect(await repliesTo(third)).toEqual([agentReply])
  expect(fake.conversations.size).toBe(1)
  expect((await runtimeOf(chat))?.agent_conversation_id).toBe(conversationOf(fake).id)
  expect(conversationOf(fake).id).not.toBe(lostConversation.id)
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
  const { fake, host } = await agentHost()
  const chat = await newRuntimeChat()
  await answered(await prompt(chat, 'Warm up'))
  await turnIs(chat, null)
  await host.disconnect()

  const waiting = await prompt(chat, 'Are you there?')
  await answered(waiting)
  await Bun.sleep(200)
  expect(await repliesTo(waiting)).toEqual([notice('The runtime host is offline')])
  expect(await turnOf(chat)).toBeNull()

  await host.connect()
  await answered(waiting, 2)
  expect(await repliesTo(waiting)).toEqual([notice('The runtime host is offline'), agentReply])
  expect(fake.prompts.map((delivered) => delivered.text)).toEqual(['Warm up', 'Are you there?'])
})
