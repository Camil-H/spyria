import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  chatAccessRows,
  chatAs,
  countOf,
  failedWith,
  messageRow,
  missingPermission,
  newChat,
  openSharedTestApp,
  posters,
  readers,
  replyTo,
  rootIn,
  succeeded,
  writtenMessage,
} from './testing/testing.ts'

const { database, resultOf, changesOf } = await openSharedTestApp()

test.each(chatAccessRows(posters))(
  'sendMessage in a thread needs chat.post and records the reply as posted with its root: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const root = await rootIn(chat)
    const reply = `message-${crypto.randomUUID()}`
    expect(await replyTo(member, chat, root, reply)).toEqual(isAllowed ? succeeded : missingPermission('chat.post'))
    expect(await messageRow(reply)).toEqual(
      isAllowed ? expect.objectContaining({ chatId: chat, threadRootId: root, replyToId: null }) : undefined,
    )
    expect((await changesOf(chat)).at(-1)).toEqual(
      isAllowed
        ? {
            seq: expect.any(Number),
            type: 'message.posted',
            actor: member.userId,
            payload: { kind: 'member', body: 'In the thread', replyToId: null, threadRootId: root },
          }
        : expect.objectContaining({ payload: expect.objectContaining({ body: 'Root' }) }),
    )
  },
)

test('a thread reply is refused in a runtime chat', async () => {
  const chat = await newChat()
  const root = await writtenMessage(chat, alice)
  const before = await countOf()
  expect(await replyTo(aliceInAcme, chat, root)).toEqual(failedWith('A runtime chat has no threads'))
  expect(await countOf()).toEqual(before)
})

test.each([
  [
    'a reply',
    async (chat: string, root: string) => {
      await replyTo(aliceInAcme, chat, root, `${root}-reply`)
      return `${root}-reply`
    },
  ],
  [
    'a deleted message',
    async (_: string, root: string) => {
      await resultOf(aliceInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: root })
      return root
    },
  ],
  ['a message of another chat', async () => 'message-standup-1'],
  ['a message of another workspace', async () => 'message-general-1'],
  ['a message that does not exist', async () => 'message-missing'],
])('a thread reply is refused on %s as its root, and writes nothing', async (_, rootOf) => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootOf(chat, await rootIn(chat))
  const before = await countOf()
  expect(await replyTo(aliceInAcme, chat, root)).toEqual(
    failedWith('A thread starts on a message of this chat that is not a reply and not deleted'),
  )
  expect(await countOf()).toEqual(before)
})

const threadMarkerOf = (userId: string, threadRootId: string) =>
  database.query.threadReadMarkers
    .findFirst({ where: { userId, threadRootId } })
    .then((marker) => marker && { chatId: marker.chatId, lastReadSeq: marker.lastReadSeq })
const markThreadRead = (member: typeof aliceInAcme, chatId: string, threadRootId: string) =>
  resultOf(member, 'conversation.markThreadRead', { workspaceId: acme, chatId, threadRootId })

test.each(chatAccessRows(readers))(
  'markThreadRead needs chat.read and moves the marker to the newest reply: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const root = await rootIn(chat)
    await replyTo(aliceInAcme, chat, root)
    expect(await markThreadRead(member, chat, root)).toEqual(isAllowed ? succeeded : missingPermission('chat.read'))
    expect(await threadMarkerOf(member.userId, root)).toEqual(isAllowed ? { chatId: chat, lastReadSeq: 2 } : undefined)
  },
)

test('markThreadRead never moves backwards and writes nothing for a thread without replies or of another chat', async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const rootWithoutReplies = await rootIn(chat)
  await replyTo(aliceInAcme, chat, root)
  expect(await markThreadRead(bobInAcme, chat, root)).toEqual(succeeded)
  expect(await threadMarkerOf(bob, root)).toEqual({ chatId: chat, lastReadSeq: 3 })
  await database.$client`update thread_read_markers set last_read_seq = 99 where user_id = ${bob}`
  expect(await markThreadRead(bobInAcme, chat, root)).toEqual(succeeded)
  expect(await threadMarkerOf(bob, root)).toEqual({ chatId: chat, lastReadSeq: 99 })
  expect(await markThreadRead(bobInAcme, chat, rootWithoutReplies)).toEqual(succeeded)
  expect(await markThreadRead(bobInAcme, 'chat-standup', root)).toEqual(succeeded)
  expect(await threadMarkerOf(bob, rootWithoutReplies)).toBeUndefined()
  expect(await database.query.threadReadMarkers.findMany({ where: { chatId: 'chat-standup' } })).toEqual([])
})
