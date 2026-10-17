import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  aliceInAcme,
  countOf,
  jobsOf,
  lee,
  messageRow,
  newChat,
  openSharedTestApp,
  replyTo,
  rootIn,
  bob,
  bobInAcme,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, eventsOf, changesOf, chatRow, messagesOf } = await openSharedTestApp()

test('startRuntimeFromMessage creates the runtime chat, its wrapped seed message, its origin and the author as Reader in one mutation, without a job', async () => {
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
    visibility: 'private',
  })
  expect(
    await database.$client`select user_id, role_id from chat_participants where chat_id = 'chat-started' order by role_id`,
  ).toEqual([
    { user_id: alice, role_id: 'owner' },
    { user_id: bob, role_id: 'reader' },
  ] as never)
  const wrapper =
    'Conversation so far, from the channel thread in #Welcome:\n\nBob (member, human) · 2026-09-30 09:00 UTC\nWelcome to the team!'
  expect(await messagesOf('chat-started')).toMatchObject([
    { id: 'message-seed', seq: 2, authorId: alice, body: wrapper, replyToId: 'message-seed' },
  ])
  expect(await database.query.messages.findMany({ where: { replyToId: 'message-welcome-1' } })).toEqual([])
  expect(await database.query.runtimeOrigins.findMany({ where: { runtimeChatId: 'chat-started' } })).toEqual([
    {
      workspaceId: acme,
      chatId: 'chat-welcome',
      runtimeChatId: 'chat-started',
      messageId: 'message-welcome-1',
      startedBy: alice,
    },
  ])
  expect(await changesOf('chat-started')).toEqual([
    {
      seq: 1,
      type: 'chat.created',
      actor: alice,
      payload: {
        name: 'Welcome to the team!',
        type: 'runtime',
        projectId: 'project-onboarding',
        originChatId: 'chat-welcome',
      },
    },
    {
      seq: 2,
      type: 'message.posted',
      actor: alice,
      payload: expect.objectContaining({ body: wrapper, replyToId: 'message-seed' }),
    },
    { seq: 3, type: 'member.invited', actor: alice, payload: { memberId: bob, roleId: 'reader' } },
  ])
  expect((await eventsOf('chat-started'))[1]?.id).toBe('message-seed')
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
  expect(await database.query.runtimeOrigins.findMany({ where: { runtimeChatId: 'chat-half-started' } })).toEqual([])
  expect(await countOf()).toEqual(before)
})

const quotedTimeOf = (date: Date | undefined) => `${date?.toISOString().slice(0, 16).replace('T', ' ')} UTC`
const startRuntimeFrom = async (messageId: string) => {
  const started = `chat-${crypto.randomUUID()}`
  expect(
    await resultOf(aliceInAcme, 'conversation.startRuntimeFromMessage', {
      workspaceId: acme,
      id: `message-${crypto.randomUUID()}`,
      chatId: started,
      messageId,
    }),
  ).toEqual(succeeded)
  return {
    wrapper: (await messagesOf(started))[0]?.body,
    participants: await database.$client`
      select user_id, role_id from chat_participants where chat_id = ${started} order by role_id`,
    origin: await database.query.runtimeOrigins.findFirst({ where: { runtimeChatId: started } }),
    invited: (await changesOf(started)).filter((change) => change.type === 'member.invited'),
  }
}
const threadWithDeletedReply = async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const bobReply = `message-${crypto.randomUUID()}`
  const deletedReply = `message-${crypto.randomUUID()}`
  const ownReply = `message-${crypto.randomUUID()}`
  await replyTo(bobInAcme, chat, root, bobReply)
  await replyTo({ workspaceId: acme, userId: lee }, chat, root, deletedReply)
  await resultOf({ workspaceId: acme, userId: lee }, 'conversation.deleteMessage', {
    workspaceId: acme,
    messageId: deletedReply,
  })
  await replyTo(aliceInAcme, chat, root, ownReply)
  const timeOf = async (id: string) => quotedTimeOf((await messageRow(id))?.createdAt)
  return {
    chat,
    root,
    bobReply,
    wrapper: [
      'Conversation so far, from the channel thread in #Runtime chat:',
      `Alice (member, human) · ${await timeOf(root)}\nRoot`,
      `Bob (member, human) · ${await timeOf(bobReply)}\nIn the thread`,
      `Alice (member, human) · ${await timeOf(ownReply)}\nIn the thread`,
    ].join('\n\n'),
  }
}

test.each([
  ['the root', ({ root }: { root: string }) => root],
  ['a reply', ({ bobReply }: { bobReply: string }) => bobReply],
])(
  'startRuntimeFromMessage from %s seeds the whole thread without its deleted reply and adds the other living author as Reader',
  async (_, sourceOf) => {
    const thread = await threadWithDeletedReply()
    const started = await startRuntimeFrom(sourceOf(thread))
    expect(started.wrapper).toBe(thread.wrapper)
    expect(started.participants).toEqual([
      { user_id: alice, role_id: 'owner' },
      { user_id: bob, role_id: 'reader' },
    ] as never)
    expect(started.invited).toEqual([
      { seq: expect.any(Number), type: 'member.invited', actor: alice, payload: { memberId: bob, roleId: 'reader' } },
    ])
    expect(started.origin).toMatchObject({ chatId: thread.chat, messageId: thread.root, startedBy: alice })
  },
)

test('startRuntimeFromMessage from a top-level message without replies seeds it alone and adds nobody when it is the starter’s', async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const started = await startRuntimeFrom(root)
  expect(started.wrapper).toBe(
    `Conversation so far, from the channel thread in #Runtime chat:\n\nAlice (member, human) · ${quotedTimeOf((await messageRow(root))?.createdAt)}\nRoot`,
  )
  expect(started.participants).toEqual([{ user_id: alice, role_id: 'owner' }] as never)
  expect(started.invited).toEqual([])
})

test('startRuntimeFromMessage leaves out of the participants a thread author who can no longer read the channel', async () => {
  const chat = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [
      { memberId: bob, roleId: 'prompter' },
      { memberId: lee, roleId: 'prompter' },
    ],
  })
  const root = await rootIn(chat)
  await replyTo({ workspaceId: acme, userId: lee }, chat, root)
  await replyTo(bobInAcme, chat, root)
  await database.$client`delete from chat_participants where chat_id = ${chat} and user_id = ${lee}`
  const started = await startRuntimeFrom(root)
  expect(started.wrapper).toContain('Lee (member, human)')
  expect(started.participants).toEqual([
    { user_id: alice, role_id: 'owner' },
    { user_id: bob, role_id: 'reader' },
  ] as never)
})

test('startRuntimeFromMessage quotes only the thread messages of the source chat', async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const otherChat = await newChat({ type: 'channel' })
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, thread_root_id, created_at)
    values (${acme}, ${otherChat}, ${`message-${crypto.randomUUID()}`}, 1, 'member', ${bob}, 'Elsewhere', ${root}, now())`
  const started = await startRuntimeFrom(root)
  expect(started.wrapper).not.toContain('Elsewhere')
  expect(started.participants).toEqual([{ user_id: alice, role_id: 'owner' }] as never)
})
