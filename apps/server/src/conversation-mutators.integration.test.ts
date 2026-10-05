import { afterAll, expect, spyOn, test } from 'bun:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { events, jobs } from '@hq/db/postgres'
import { createTestDatabase, startZeroCache } from '@hq/db/testing'
import { createApp } from './app.ts'
import { maximumJobAttempts, startJobWorker } from './job-worker.ts'
import { sessionTokenOf, testAuthSettings } from './testing.ts'

const testDatabase = await createTestDatabase()
const { database } = testDatabase
const app = createApp({ database, ...testAuthSettings })
const server = Bun.serve({ port: 0, fetch: app.fetch })
const appId = 'hqconversationtest'
const zeroCache = await startZeroCache({
  databaseName: testDatabase.name,
  port: 4896,
  appId,
  serverUrl: server.url.origin,
}).catch(async (error) => {
  await server.stop(true)
  await testDatabase.drop()
  throw error
})
afterAll(async () => {
  await zeroCache.stop()
  await server.stop(true)
  await testDatabase.drop()
})

const acme = 'workspace-acme'
const globex = 'workspace-globex'
const alice = 'member-alice'
const bob = 'member-bob'
const aliceInAcme = { workspaceId: acme, userId: alice }
const bobInAcme = { workspaceId: acme, userId: bob }
const succeeded = {}
const failedWith = (message: string) => ({ error: 'app', message })
const agentReplyText = 'Understood, working on it.'

const tokenOf = (workspaceId: string, userId: string) => sessionTokenOf(database, workspaceId, userId)

const resultOf = async (
  { workspaceId, userId }: { workspaceId: string; userId: string },
  name: string,
  args: Record<string, unknown>,
) => {
  const response = await app.request(`/api/mutate?schema=${appId}_0&appID=${appId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenOf(workspaceId, userId)}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [{ type: 'custom', id: 1, clientID: crypto.randomUUID(), name, args: [args], timestamp: Date.now() }],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  return ((await response.json()) as { mutations: { result: unknown }[] }).mutations[0]?.result
}

const messageRow = (id: string) => database.query.messages.findFirst({ where: { id } })
const chatRow = (id: string) => database.query.chats.findFirst({ where: { id } })
const messagesOf = (chatId: string) => database.query.messages.findMany({ where: { chatId }, orderBy: { seq: 'asc' } })
const eventsOf = async (chatId: string) =>
  (await database.select().from(events))
    .filter((event) => event.chatId === chatId)
    .toSorted((first, second) => first.seq - second.seq)
const jobsOf = async (messageId: string) =>
  (await database.select().from(jobs)).filter((job) => (job.payload as { messageId: string }).messageId === messageId)
const jobRow = async (id: string) => (await database.select().from(jobs)).find((job) => job.id === id)
const countOf = async () => ({
  messages: (await database.query.messages.findMany()).length,
  events: (await database.select().from(events)).length,
  jobs: (await database.select().from(jobs)).length,
  chats: (await database.query.chats.findMany()).length,
})
const sendTo = (member: typeof aliceInAcme, chatId: string, id: string, text: string) =>
  resultOf(member, 'conversation.sendMessage', { workspaceId: member.workspaceId, id, chatId, text })
const waitFor = async (isDone: () => Promise<boolean>) => {
  for (let attempt = 1; !(await isDone()); attempt++) {
    if (attempt === 200) throw new Error('The condition was not met within 10 s')
    await sleep(50)
  }
}

test('sendMessage in a channel appends a posted event and the projection at the next seq, without a job', async () => {
  const before = Date.now()
  expect(await sendTo(aliceInAcme, 'chat-welcome', 'message-sent', '  Hello  ')).toEqual(succeeded)
  const message = await messageRow('message-sent')
  expect(message).toMatchObject({ chatId: 'chat-welcome', seq: 3, kind: 'member', authorId: alice, body: 'Hello' })
  expect(message?.createdAt.getTime()).toBeGreaterThanOrEqual(before)
  expect((await eventsOf('chat-welcome')).at(-1)).toMatchObject({
    id: 'message-sent',
    seq: 3,
    type: 'message.posted',
    actor: alice,
    payload: { kind: 'member', body: 'Hello', detail: null, replyToId: null },
  })
  expect(await jobsOf('message-sent')).toEqual([])
})

test('sendMessage in a runtime chat enqueues one agent reply job in the same transaction', async () => {
  expect(await sendTo(aliceInAcme, 'chat-invoice-bug', 'message-to-agent', 'Fix it')).toEqual(succeeded)
  expect(await messageRow('message-to-agent')).toMatchObject({ seq: 5, replyToId: null })
  expect(await jobsOf('message-to-agent')).toMatchObject([
    { workspaceId: acme, type: 'agent.reply', attempts: 0, state: 'queued' },
  ])
})

test('editMessage and deleteMessage append events, edit the projection and blank a deleted body', async () => {
  await sendTo(bobInAcme, 'chat-standup', 'message-to-change', 'Draft plan')
  expect(
    await resultOf(bobInAcme, 'conversation.editMessage', {
      workspaceId: acme,
      messageId: 'message-to-change',
      text: 'Final plan',
    }),
  ).toEqual(succeeded)
  expect(await messageRow('message-to-change')).toMatchObject({ body: 'Final plan', deletedAt: null })
  expect((await messageRow('message-to-change'))?.editedAt).not.toBeNull()
  expect(
    await resultOf(bobInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: 'message-to-change' }),
  ).toEqual(succeeded)
  expect(await messageRow('message-to-change')).toMatchObject({ seq: 2, body: '' })
  expect((await messageRow('message-to-change'))?.deletedAt).not.toBeNull()
  expect(
    (await eventsOf('chat-standup')).map(({ seq, type, actor, payload }) => ({ seq, type, actor, payload })),
  ).toEqual([
    { seq: 1, type: 'message.posted', actor: bob, payload: expect.anything() },
    { seq: 2, type: 'message.posted', actor: bob, payload: expect.objectContaining({ body: 'Draft plan' }) },
    { seq: 3, type: 'message.edited', actor: bob, payload: { messageId: 'message-to-change', body: 'Final plan' } },
    { seq: 4, type: 'message.deleted', actor: bob, payload: { messageId: 'message-to-change' } },
  ])
})

test('markChatRead moves the marker to the newest seq and never backwards', async () => {
  const markerOf = (chatId: string) =>
    database.query.readMarkers.findFirst({ where: { chatId, userId: alice } }).then((marker) => marker?.lastReadSeq)
  expect(
    await resultOf(aliceInAcme, 'conversation.markChatRead', { workspaceId: acme, chatId: 'chat-standup' }),
  ).toEqual(succeeded)
  expect(await markerOf('chat-standup')).toBe(2)
  await database.$client`update read_markers set last_read_seq = 99 where chat_id = 'chat-standup' and user_id = ${alice}`
  expect(
    await resultOf(aliceInAcme, 'conversation.markChatRead', { workspaceId: acme, chatId: 'chat-standup' }),
  ).toEqual(succeeded)
  expect(await markerOf('chat-standup')).toBe(99)
})

test('startRuntimeFromMessage creates the runtime chat and its seed message in one mutation, without a job', async () => {
  expect(
    await resultOf(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: 'message-seed',
      chatId: 'chat-started',
      messageId: 'message-welcome-1',
    }),
  ).toEqual(succeeded)
  expect(await chatRow('chat-started')).toMatchObject({
    type: 'runtime',
    name: 'Welcome to the team!',
    originChatId: 'chat-welcome',
    projectId: 'project-onboarding',
    ownerUserId: alice,
  })
  expect(await messagesOf('chat-started')).toMatchObject([
    { id: 'message-seed', seq: 2, authorId: alice, body: 'Welcome to the team!', replyToId: 'message-welcome-1' },
  ])
  expect(await eventsOf('chat-started')).toMatchObject([
    { seq: 1, type: 'chat.created' },
    { id: 'message-seed', seq: 2, type: 'message.posted' },
  ])
  expect(await jobsOf('message-seed')).toEqual([])
})

test('startRuntimeFromMessage rolls the new chat back when its seed message cannot be written', async () => {
  const before = await countOf()
  expect(
    await resultOf(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: 'message-welcome-2',
      chatId: 'chat-half-started',
      messageId: 'message-welcome-1',
    }),
  ).toMatchObject({ error: 'app' })
  expect(await chatRow('chat-half-started')).toBeUndefined()
  expect(await countOf()).toEqual(before)
})

test.each([
  [
    'sendMessage to a chat of another workspace',
    'conversation.sendMessage',
    { id: 'message-x', chatId: 'chat-launch-plan', text: 'Hi' },
    'Chat chat-launch-plan was not found',
  ],
  [
    'editMessage of another workspace',
    'conversation.editMessage',
    { messageId: 'message-general-1', text: 'Taken' },
    'Message message-general-1 was not found',
  ],
  [
    'deleteMessage of another workspace',
    'conversation.deleteMessage',
    { messageId: 'message-general-1' },
    'Message message-general-1 was not found',
  ],
  [
    'startRuntimeFromMessage from another workspace',
    'conversation.startRuntimeFromMessage',
    { id: 'message-y', chatId: 'chat-y', messageId: 'message-general-1' },
    'Message message-general-1 was not found',
  ],
  [
    'editMessage of another member',
    'conversation.editMessage',
    { messageId: 'message-welcome-2', text: 'Taken' },
    'Only the author can change a message',
  ],
  [
    'deleteMessage of another member',
    'conversation.deleteMessage',
    { messageId: 'message-welcome-2' },
    'Only the author can change a message',
  ],
  [
    'a blank message',
    'conversation.sendMessage',
    { id: 'message-blank', chatId: 'chat-welcome', text: '  ' },
    'A message must contain at least one non-blank character',
  ],
])('refuses %s and writes nothing', async (_, name, args, message) => {
  const before = await countOf()
  expect(await resultOf(bobInAcme, name, { workspaceId: acme, ...args })).toEqual(failedWith(message))
  expect(await countOf()).toEqual(before)
})

test('refuses arguments naming another workspace than the token', async () => {
  expect(
    await resultOf(bobInAcme, 'conversation.sendMessage', {
      workspaceId: globex,
      id: 'message-foreign',
      chatId: 'chat-general',
      text: 'Hi',
    }),
  ).toEqual(failedWith('The change targets a workspace other than the current one'))
  expect(await messageRow('message-foreign')).toBeUndefined()
})

test('two concurrent senders of 15 messages each get 30 distinct contiguous seqs', async () => {
  const firstSeq = ((await messagesOf('chat-welcome')).at(-1)?.seq ?? 0) + 1
  const sends = [aliceInAcme, bobInAcme].flatMap((member) =>
    Array.from({ length: 15 }, (_, index) =>
      sendTo(member, 'chat-welcome', `message-race-${member.userId}-${index}`, `Race ${index}`),
    ),
  )
  expect(await Promise.all(sends)).toEqual(Array(30).fill(succeeded))
  const raced = (await messagesOf('chat-welcome')).filter((message) => message.id.startsWith('message-race-'))
  expect(raced.map((message) => message.seq)).toEqual(Array.from({ length: 30 }, (_, index) => firstSeq + index))
  expect((await eventsOf('chat-welcome')).slice(-30).map((event) => event.seq)).toEqual(
    raced.map((message) => message.seq),
  )
})

test('the job worker appends the agent reply exactly once and marks the job done', async () => {
  await sendTo(aliceInAcme, 'chat-research', 'message-question', 'Find the pricing')
  const worker = startJobWorker(database, { pollIntervalMilliseconds: 20 })
  await waitFor(async () => (await jobsOf('message-question'))[0]?.state === 'done')
  await sleep(200)
  await worker.stop()
  expect(await messagesOf('chat-research')).toMatchObject([
    { id: 'message-question', seq: 1, kind: 'member' },
    { seq: 2, kind: 'agent', authorId: null, body: agentReplyText, replyToId: 'message-question' },
  ])
  expect((await eventsOf('chat-research')).map(({ seq, type, actor }) => ({ seq, type, actor }))).toEqual([
    { seq: 1, type: 'message.posted', actor: alice },
    { seq: 2, type: 'message.replied', actor: null },
  ])
  expect(await jobsOf('message-question')).toMatchObject([{ state: 'done', attempts: 1 }])
})

test('two workers never process the same job twice', async () => {
  const questionIds = Array.from({ length: 12 }, (_, index) => `message-burst-${index}`)
  await Promise.all(questionIds.map((id) => sendTo(aliceInAcme, 'chat-research', id, id)))
  const workers = [
    startJobWorker(database, { pollIntervalMilliseconds: 5 }),
    startJobWorker(database, { pollIntervalMilliseconds: 5 }),
  ]
  await waitFor(async () => (await Promise.all(questionIds.map(jobsOf))).every(([job]) => job?.state === 'done'))
  await sleep(200)
  await Promise.all(workers.map((worker) => worker.stop()))
  const replies = (await messagesOf('chat-research')).filter((message) => questionIds.includes(message.replyToId ?? ''))
  expect(replies.map((reply) => reply.replyToId).toSorted()).toEqual(questionIds.toSorted())
  expect(new Set((await eventsOf('chat-research')).map((event) => event.seq)).size).toBe(
    (await eventsOf('chat-research')).length,
  )
})

test('a failing job is retried up to its bound, then dead and logged once', async () => {
  await database.insert(jobs).values({
    workspaceId: acme,
    id: 'job-broken',
    type: 'agent.reply',
    payload: { messageId: 'message-missing' },
    runAt: new Date(),
    attempts: 0,
    state: 'queued',
  })
  const errorLog = spyOn(console, 'error').mockImplementation(() => {})
  const worker = startJobWorker(database, { pollIntervalMilliseconds: 5, retryDelayMilliseconds: 0 })
  await waitFor(async () => (await jobRow('job-broken'))?.state === 'failed')
  await sleep(100)
  await worker.stop()
  expect(await jobRow('job-broken')).toMatchObject({
    attempts: maximumJobAttempts,
    state: 'failed',
  })
  expect(errorLog.mock.calls.filter(([message]) => String(message).includes('job-broken'))).toHaveLength(1)
  errorLog.mockRestore()
})
