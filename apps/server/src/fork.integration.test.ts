import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  type aliceInAcme,
  bob,
  bobInAcme,
  chatAccessRows,
  chatAs,
  failedWith,
  jobsOf,
  missingPermission,
  newChat,
  openSharedTestApp,
  readers,
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

test('forkChat gives the forker a private runtime chat seeded with the source’s member and agent messages read from its event log, edits and deletions applied, and leaves the source unchanged', async () => {
  const source = await newChat({ participants: [{ memberId: bob, roleId: 'reader' }] })
  const at = (minute: number) => `2026-10-17T09:0${minute}:00.000Z`
  const [firstId, deletedId] = [`message-${crypto.randomUUID()}`, `message-${crypto.randomUUID()}`]
  const posted = (kind: string, body: string) => ({ kind, body, replyToId: null })
  const events = [
    { id: firstId, type: 'message.posted', actor: alice, payload: posted('member', 'Find the bug.') },
    { type: 'message.posted', actor: null, payload: posted('step', 'Read invoice.ts') },
    { type: 'message.posted', actor: null, payload: posted('agent', 'Found it.') },
    { type: 'message.posted', actor: null, payload: posted('notice', 'Stopped by Alice') },
    { id: deletedId, type: 'message.posted', actor: alice, payload: { ...posted('member', ''), redacted: true } },
    { type: 'message.edited', actor: alice, payload: { messageId: firstId, body: 'Find the bug, please.' } },
    { type: 'message.deleted', actor: alice, payload: { messageId: deletedId } },
    { type: 'message.posted', actor: alice, payload: posted('member', 'Fix it.') },
  ]
  for (const [index, { id = crypto.randomUUID(), type, actor, payload }] of events.entries())
    await database.$client`
      insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      values (${acme}, ${source}, ${id}, ${index + 1}, ${type}, ${actor}, ${JSON.stringify(payload)}::jsonb, ${at(index + 1)})`
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
    'Alice (member, human) · 2026-10-17 09:01 UTC\nFind the bug, please.',
    'Agent (agent) · 2026-10-17 09:03 UTC\nFound it.',
    'Alice (member, human) · 2026-10-17 09:08 UTC\nFix it.',
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
