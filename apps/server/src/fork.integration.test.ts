import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  type aliceInAcme,
  chatAccessRows,
  chatAs,
  failedWith,
  jobsOf,
  missingPermission,
  newChat,
  openSharedTestApp,
  readers,
  bob,
  bobInAcme,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, eventsOf, changesOf, chatRow, messagesOf } = await openSharedTestApp()

const forkOf = async (member: typeof aliceInAcme, sourceChatId: string) => {
  const forked = `chat-${crypto.randomUUID()}`
  const wrapperId = `message-${crypto.randomUUID()}`
  const result = await resultOf(member, 'conversation.forkChat', {
    workspaceId: acme,
    id: wrapperId,
    chatId: forked,
    sourceChatId,
  })
  return { result, forked, wrapperId }
}

test.each(chatAccessRows(readers))(
  'forkChat needs chat.read on a runtime source chat: $name',
  async ({ member, isAllowed, ...role }) => {
    const source = await chatAs(role)
    const { result, forked } = await forkOf(member, source)
    const isForked = isAllowed && !role.isPublic
    expect(result).toEqual(
      isForked
        ? succeeded
        : isAllowed
          ? failedWith('Only runtime chats can be forked')
          : missingPermission('chat.read'),
    )
    expect(await chatRow(forked)).toEqual(
      isForked
        ? expect.objectContaining({ ownerUserId: member.userId, originChatId: source, visibility: 'private' })
        : undefined,
    )
  },
)

test('forkChat gives the forker a private runtime chat seeded with the source’s member and agent messages, and leaves the source unchanged', async () => {
  const source = await newChat({ participants: [{ memberId: bob, roleId: 'reader' }] })
  const at = (minute: number) => `2026-10-17T09:0${minute}:00.000Z`
  const rows = [
    { seq: 1, kind: 'member', authorId: alice, body: 'Find the bug.', deletedAt: null },
    { seq: 2, kind: 'step', authorId: null, body: 'Read invoice.ts', deletedAt: null },
    { seq: 3, kind: 'agent', authorId: null, body: 'Found it.', deletedAt: null },
    { seq: 4, kind: 'notice', authorId: null, body: 'Stopped by Alice', deletedAt: null },
    { seq: 5, kind: 'member', authorId: alice, body: '', deletedAt: at(6) },
    { seq: 6, kind: 'member', authorId: alice, body: 'Fix it.', deletedAt: null },
  ]
  for (const { seq, kind, authorId, body, deletedAt } of rows)
    await database.$client`
      insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at, deleted_at)
      values (${acme}, ${source}, ${`message-${crypto.randomUUID()}`}, ${seq}, ${kind}, ${authorId}, ${body}, ${at(seq)}, ${deletedAt})`
  const sourceBefore = {
    messages: await messagesOf(source),
    chat: await chatRow(source),
    events: await eventsOf(source),
  }

  const { result, forked, wrapperId } = await forkOf(bobInAcme, source)

  expect(result).toEqual(succeeded)
  expect(await chatRow(forked)).toMatchObject({
    type: 'runtime',
    name: 'Runtime chat (fork)',
    originChatId: source,
    ownerUserId: bob,
    visibility: 'private',
  })
  expect(await database.$client`select user_id, role_id from chat_participants where chat_id = ${forked}`).toEqual([
    { user_id: bob, role_id: 'owner' },
  ] as never)
  const wrapper = [
    'Conversation so far, from the runtime chat Runtime chat:',
    'Alice (member, human) · 2026-10-17 09:01 UTC\nFind the bug.',
    'Agent (agent) · 2026-10-17 09:03 UTC\nFound it.',
    'Alice (member, human) · 2026-10-17 09:06 UTC\nFix it.',
  ].join('\n\n')
  expect(await messagesOf(forked)).toMatchObject([
    { id: wrapperId, seq: 2, kind: 'member', authorId: bob, body: wrapper, replyToId: wrapperId },
  ])
  expect(await changesOf(forked)).toEqual([
    {
      seq: 1,
      type: 'chat.created',
      actor: bob,
      payload: { name: 'Runtime chat (fork)', type: 'runtime', projectId: null, originChatId: source },
    },
    {
      seq: 2,
      type: 'message.posted',
      actor: bob,
      payload: expect.objectContaining({ body: wrapper, replyToId: wrapperId }),
    },
  ])
  expect(await jobsOf(wrapperId)).toEqual([])
  expect({ messages: await messagesOf(source), chat: await chatRow(source), events: await eventsOf(source) }).toEqual(
    sourceBefore,
  )
  expect(
    await database.$client`select user_id, role_id from chat_participants where chat_id = ${source} order by role_id`,
  ).toEqual([
    { user_id: alice, role_id: 'owner' },
    { user_id: bob, role_id: 'reader' },
  ] as never)
})
