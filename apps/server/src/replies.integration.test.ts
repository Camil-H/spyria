import { expect, test } from 'bun:test'
import {
  acme,
  aliceInAcme,
  countOf,
  failedWith,
  messageRow,
  newChat,
  openSharedTestApp,
  replyTo,
  rootIn,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, changesOf } = await openSharedTestApp()

const quotingReply = async (
  member: typeof aliceInAcme,
  chatId: string,
  quotedMessageId: string,
  fields: { threadRootId?: string } = {},
) => {
  const id = `message-${crypto.randomUUID()}`
  const result = await resultOf(member, 'conversation.sendMessage', {
    workspaceId: acme,
    id,
    chatId,
    text: 'Agreed',
    quotedMessageId,
    ...fields,
  })
  return { id, result }
}

test.each([
  ['a channel', 'channel' as const, false],
  ['a thread of a channel', 'channel' as const, true],
  ['a runtime chat', 'runtime' as const, false],
])('a reply in %s records the message it quotes on its row and in its posted event', async (_, type, inThread) => {
  const chat = await newChat({ type })
  const quoted = await rootIn(chat)
  const threadRootId = inThread ? quoted : undefined
  const { id, result } = await quotingReply(aliceInAcme, chat, quoted, { ...(threadRootId && { threadRootId }) })
  expect(result).toEqual(succeeded)
  expect(await messageRow(id)).toMatchObject({ quotedMessageId: quoted, threadRootId: threadRootId ?? null })
  expect((await changesOf(chat)).at(-1)).toMatchObject({
    type: 'message.posted',
    payload: { body: 'Agreed', quotedMessageId: quoted },
  })
})

test('a reply quotes a thread reply of its chat from the channel flow', async () => {
  const chat = await newChat({ type: 'channel' })
  const root = await rootIn(chat)
  const threadReply = `message-${crypto.randomUUID()}`
  await replyTo(aliceInAcme, chat, root, threadReply)
  const { id, result } = await quotingReply(aliceInAcme, chat, threadReply)
  expect(result).toEqual(succeeded)
  expect(await messageRow(id)).toMatchObject({ quotedMessageId: threadReply, threadRootId: null })
})

test.each([
  [
    'a deleted message',
    async (_: string, quoted: string) => {
      await resultOf(aliceInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: quoted })
      return quoted
    },
  ],
  [
    'an agent step',
    async (chat: string) => {
      const step = `message-${crypto.randomUUID()}`
      await database.$client`
        insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
        values (${acme}, ${chat}, ${step}, 99, 'step', null, 'command', now())`
      return step
    },
  ],
  ['a message of another chat', async () => 'message-standup-1'],
  ['a message of another workspace', async () => 'message-general-1'],
  ['a message that does not exist', async () => 'message-missing'],
])('a reply is refused when it quotes %s, and writes nothing', async (_, quotedOf) => {
  const chat = await newChat({ type: 'channel' })
  const quoted = await quotedOf(chat, await rootIn(chat))
  const before = await countOf()
  expect((await quotingReply(aliceInAcme, chat, quoted)).result).toEqual(
    failedWith('A reply quotes a member’s or the agent’s message of this chat that is not deleted'),
  )
  expect(await countOf()).toEqual(before)
})
