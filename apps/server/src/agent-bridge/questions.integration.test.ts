import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { rebuildMessages } from '@hq/conversation/server'
import { schema } from '@hq/db/zero'
import type { ChatId } from '@hq/kernel'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import {
  acme,
  addLlmKey,
  alice,
  aliceInAcme,
  bob,
  sessionTokenOf,
  startAgentStack,
  succeeded,
  waitFor,
} from '../testing.ts'

setDefaultTimeout(40_000)
const { database, app, agentHost, mutate, newRuntimeChat, prompt, turnOf, messagesOf, finished, ...stack } =
  await startAgentStack({ routing: true })
afterEach(async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id = ${alice} and removed_at is null`
})

type QuestionFrame = { chatId: string; promptId?: string; isSnapshot?: boolean; question: Record<string, unknown> }
const machine = async (signedIn = ['claude']) => (await agentHost('Machine', { ownerId: alice, signedIn })).relay
const workspaceHost = () => agentHost('Workspace host')
const repliesTo = (messageId: string) => stack.repliesTo(messageId, ['kind', 'body', 'step'])
const questionsIn = (frames: string[]) =>
  frames.map((frame) => JSON.parse(frame) as QuestionFrame).filter((frame) => frame.question !== undefined)
const askedIn = async (frames: string[], count = 1) => {
  await waitFor(() => questionsIn(frames).length >= count)
  return String(questionsIn(frames)[count - 1]?.question.questionId)
}
const post = async (path: string, body: object, member: string = alice) =>
  (
    await app.request(path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sessionTokenOf(database, acme, member)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  ).status
const answer = (chat: ChatId, questionId: string, body: object, member?: string) =>
  post(`/api/chats/${chat}/questions/${questionId}`, body, member)
const planMode = (chat: ChatId, enabled: boolean, member?: string) =>
  post(`/api/chats/${chat}/plan-mode`, { enabled }, member)
const isPlanning = async (chat: ChatId) =>
  (await database.$client`select is_planning from chats where id = ${chat}`)[0]?.is_planning
const questionItemsOf = async (chat: ChatId) =>
  (await messagesOf(chat)).filter((message) => (message.step as { type?: string } | null)?.type === 'question')
const ended = async (promptId: string, chat: ChatId) => {
  await waitFor(async () => (await turnOf(chat)) === null)
  return repliesTo(promptId)
}

const claudeQuestion = {
  sessionUpdate: 'question',
  questionId: expect.any(String),
  toolCallId: 'ask-1',
  kind: 'question',
  questions: [
    {
      id: 'question_0',
      header: 'Database',
      text: 'Which database should we use?',
      options: [
        { value: 'Postgres', label: 'Postgres', description: 'Relational' },
        { value: 'SQLite', label: 'SQLite', description: 'Embedded' },
      ],
      multi: false,
      free: true,
    },
  ],
}

test('a machine question reaches viewers live and again after a reconnect; the owner’s answer continues the turn and is stored once', async () => {
  const relay = await machine()
  const chat = await newRuntimeChat({ harness: 'claude-code' })
  const frames = await stack.subscribedFrames(chat)
  const asked = await prompt(chat, 'stub:ask')
  const questionId = await askedIn(frames)
  expect(questionsIn(frames)[0]).toEqual({ chatId: chat, promptId: asked, question: claudeQuestion })

  relay.dropSockets()
  await waitFor(() => relay.socketPaths.length === 2)
  await askedIn(frames, 2)
  const reconnected = await stack.subscribedFrames(chat)
  expect(questionsIn(reconnected)).toEqual([
    { chatId: chat, promptId: asked, question: { ...claudeQuestion, questionId }, isSnapshot: true },
  ])

  expect(await answer(chat, questionId, { answers: { question_0: 'SQLite' } }, bob)).toBe(403)
  expect(await answer(chat, questionId, { answers: 'SQLite' })).toBe(400)
  for (const refusedId of ['not.an.id', 'a%20b', 'q'.repeat(65)])
    expect(await answer(chat, refusedId, { answers: { question_0: 'SQLite' } })).toBe(400)
  expect(await answer(chat, questionId, { answers: { question_0: 'SQLite' }, answeredBy: bob })).toBe(200)
  const replies = await finished(asked, chat)
  expect(replies.map(({ body }) => body)).toEqual([
    '[t1]',
    'question',
    'answer:{"action":"accept","content":{"question_0":"SQLite"}} Hello from the stub (model stub-default, mode bypassPermissions).',
  ])
  const { sessionUpdate: _, ...stored } = { ...claudeQuestion, questionId }
  expect(replies[1]).toMatchObject({
    kind: 'step',
    step: { type: 'question', ...stored, answers: { question_0: 'SQLite' }, answeredBy: alice },
  })
  expect(await answer(chat, questionId, { answers: { question_0: 'Postgres' } })).toBe(409)
  expect(await questionItemsOf(chat)).toHaveLength(1)

  const live = await messagesOf(chat)
  await zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, { chatId: chat }))
  expect(await messagesOf(chat)).toEqual(live)
})

test('on an HQ runtime chat another member who may prompt answers, a member without a key cannot', async () => {
  await workspaceHost()
  await database.$client`delete from llm_credentials where user_id = ${bob}`
  const chat = await newRuntimeChat({ defaultModel: 'fake/fake-medium' })
  const frames = await stack.subscribedFrames(chat)
  const asked = await prompt(chat, 'stub:ask')
  const questionId = await askedIn(frames)
  expect(questionsIn(frames)[0]?.question).toMatchObject({
    kind: 'question',
    toolCallId: 'ask-1',
    questions: [{ id: 'answer', text: 'Which database should we use?', free: true }],
  })

  expect(await answer(chat, questionId, { answers: { answer: 'SQLite' } }, bob)).toBe(403)
  await addLlmKey(bob, 'OpenAI')
  expect(await answer(chat, questionId, { answers: {}, free: { answer: 'Buildkite' } }, bob)).toBe(200)
  expect(await answer(chat, questionId, { answers: { answer: 'Postgres' } })).toBe(409)
  const replies = await finished(asked, chat)
  expect(replies.map(({ body }) => body)).toEqual([
    '[t1]',
    'tool',
    'question',
    'answer:The member answered: Buildkite Hello from the stub (model hq/fake/fake-medium, mode default).',
  ])
  expect(replies[2]?.step).toMatchObject({
    type: 'question',
    answers: {},
    free: { answer: 'Buildkite' },
    answeredBy: bob,
  })
})

test('Stop while a question waits stores it closed as stopped, a late answer is refused, the next prompt works', async () => {
  await machine()
  const chat = await newRuntimeChat({ harness: 'claude-code' })
  const frames = await stack.subscribedFrames(chat)
  const asked = await prompt(chat, 'stub:ask')
  const questionId = await askedIn(frames)
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await ended(asked, chat)
  await waitFor(async () => (await questionItemsOf(chat)).length === 1)
  const replies = await repliesTo(asked)
  expect(replies.map(({ kind, body }) => `${kind}:${body}`)).toEqual([
    'agent:[t1]',
    'notice:Stopped by Alice',
    'step:question',
  ])
  expect(replies[2]?.step).toMatchObject({ type: 'question', questionId, closed: 'stopped' })
  expect(await answer(chat, questionId, { answers: { question_0: 'SQLite' } })).toBe(409)
  expect((await finished(await prompt(chat, 'Carry on'), chat)).at(-1)?.body).toContain('[t2] ')
})

test('plan approval continues the turn and leaves plan mode; keep planning ends the turn without a Stopped notice and stays in plan mode', async () => {
  await machine()
  const chat = await newRuntimeChat({ harness: 'claude-code' })
  const frames = await stack.subscribedFrames(chat)
  const approved = await prompt(chat, 'stub:exit-plan')
  const approvedId = await askedIn(frames)
  expect(questionsIn(frames)[0]?.question).toMatchObject({ kind: 'plan', plan: '1. Create x.txt\n2. Done' })
  await waitFor(async () => (await isPlanning(chat)) === true)
  expect(await answer(chat, approvedId, { approve: true })).toBe(200)
  const approvedReplies = await finished(approved, chat)
  expect(approvedReplies.map(({ kind, body }) => `${kind}:${body}`)).toEqual([
    'agent:[t1]',
    'step:tool',
    'step:question',
    'agent:plan:exit-plan-bypass',
    'agent:Hello from the stub (model stub-default, mode bypassPermissions).',
  ])
  expect(approvedReplies.find(({ body }) => body === 'question')?.step).toMatchObject({
    type: 'question',
    kind: 'plan',
    plan: '1. Create x.txt\n2. Done',
    approved: true,
    answeredBy: alice,
  })
  expect(await isPlanning(chat)).toBe(false)

  const kept = await prompt(chat, 'stub:exit-plan')
  const keptId = await askedIn(frames, 2)
  expect(await answer(chat, keptId, { approve: false })).toBe(200)
  const keptReplies = await ended(kept, chat)
  expect(keptReplies.map(({ kind, body }) => `${kind}:${body}`)).toEqual([
    'agent:[t2]',
    'step:tool',
    'step:question',
    'agent:plan:reject',
  ])
  expect(keptReplies[2]?.step).toMatchObject({ kind: 'plan', toolCallId: 'exit-plan-2', approved: false })
  expect(await isPlanning(chat)).toBe(true)
  expect((await finished(await prompt(chat, 'stub:write'), chat)).at(-1)?.body).toBe(
    '[t3] write:reject Hello from the stub (model stub-default, mode plan).',
  )
})

test.each([
  { tool: 'claude', harness: 'claude-code' },
  { tool: 'codex', harness: 'codex' },
])('the plan mode endpoint toggles $harness plan mode for who may prompt', async ({ tool, harness }) => {
  await machine([tool])
  const chat = await newRuntimeChat({ harness })
  expect(await planMode(chat, true)).toBe(409)
  await finished(await prompt(chat, 'Hello'), chat)
  expect(await planMode(chat, true, bob)).toBe(403)
  expect(await post(`/api/chats/${chat}/plan-mode`, { enabled: 'yes' })).toBe(400)
  expect(await planMode(chat, true)).toBe(200)
  await waitFor(async () => (await isPlanning(chat)) === true)
  if (harness === 'claude-code')
    expect((await finished(await prompt(chat, 'Plan'), chat)).at(-1)?.body).toContain('mode plan).')
  expect(await planMode(chat, false)).toBe(200)
  await waitFor(async () => (await isPlanning(chat)) === false)
  expect((await finished(await prompt(chat, 'Build'), chat)).at(-1)?.body).toContain('mode bypassPermissions).')
})

test('a question in a delegated sub-conversation is answered with the assumption and stored in the delegation', async () => {
  const { host, relay } = await workspaceHost()
  const chat = await newRuntimeChat({ defaultModel: 'fake/fake-medium' })
  stack.setFakeLlmScript({ delegateRoute: { tier: 'small', confidence: 'high', effort: 'low' } })
  const parent = await prompt(chat, 'stub:long')
  await stack.commandShown(parent)
  const token = (relay.created[0] as { secrets: { HQ_LLM_TOKEN: { value: string } } }).secrets.HQ_LLM_TOKEN.value
  const delegated = await host.modelCall({
    path: '/mcp/router',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'delegate', arguments: { task: 'stub:ask', effort: 'small' } },
    }),
  })
  const assumption = 'No member is available; decide yourself and state your assumption.'
  expect(JSON.parse(delegated.body).result.content[0].text).toContain(`answer:The member answered: ${assumption} `)
  await waitFor(async () => (await questionItemsOf(chat)).length === 1)
  expect((await questionItemsOf(chat))[0]?.step).toMatchObject({
    type: 'question',
    free: { answer: assumption },
    delegation: { model: 'fake/fake-small' },
  })
  expect(await mutate(aliceInAcme, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(succeeded)
  await waitFor(async () => (await turnOf(chat)) === null)
})
