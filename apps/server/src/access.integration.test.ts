import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  chatAccessRows,
  chatAs,
  countOf,
  failedWith,
  messageRow,
  missingPermission,
  openSharedTestApp,
  posters,
  readers,
  bob,
  bobInAcme,
  sendTo,
  succeeded,
  writtenMessage,
} from './testing/testing.ts'

const { database, resultOf, chatRow } = await openSharedTestApp()

const configurers = ['editor', 'owner'] as const

test.each(chatAccessRows(posters))('sendMessage needs chat.post: $name', async ({ member, isAllowed, ...role }) => {
  const chat = await chatAs(role, 'channel')
  const before = await countOf()
  const result = await sendTo(member, chat, `message-${crypto.randomUUID()}`, 'Hi')
  expect(result).toEqual(isAllowed ? succeeded : missingPermission('chat.post'))
  if (!isAllowed) expect(await countOf()).toEqual(before)
})

test.each(chatAccessRows(posters))(
  'editMessage and deleteMessage need the author and chat.post: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const own = await writtenMessage(chat, member.userId)
    const expected = isAllowed ? succeeded : missingPermission('chat.post')
    expect(
      await resultOf(member, 'conversation.editMessage', { workspaceId: acme, messageId: own, text: 'New' }),
    ).toEqual(expected)
    expect(await resultOf(member, 'conversation.deleteMessage', { workspaceId: acme, messageId: own })).toEqual(
      expected,
    )
    expect((await messageRow(own))?.body).toBe(isAllowed ? '' : 'Written before')
  },
)

test.each(chatAccessRows(readers))('markChatRead needs chat.read: $name', async ({ member, isAllowed, ...role }) => {
  const chat = await chatAs(role)
  await writtenMessage(chat, alice)
  expect(await resultOf(member, 'conversation.markChatRead', { workspaceId: acme, chatId: chat })).toEqual(
    isAllowed ? succeeded : missingPermission('chat.read'),
  )
  expect(await database.query.readMarkers.findFirst({ where: { chatId: chat, userId: member.userId } })).toEqual(
    isAllowed ? expect.objectContaining({ lastReadSeq: 1 }) : undefined,
  )
})

test.each(chatAccessRows(posters))(
  'retryAgent needs chat.post before it looks at the runtime: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    expect(await resultOf(member, 'conversation.retryAgent', { workspaceId: acme, chatId: chat })).toEqual(
      isAllowed ? failedWith('Only a runtime that could not start can be retried') : missingPermission('chat.post'),
    )
  },
)

test.each(chatAccessRows(configurers))(
  'stopAgent needs session.configure: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    expect(await resultOf(member, 'conversation.stopAgent', { workspaceId: acme, chatId: chat })).toEqual(
      isAllowed ? succeeded : missingPermission('session.configure'),
    )
  },
)

test.each(chatAccessRows(configurers))(
  'updateChatRouting of the model, subagents and Pi effort needs session.configure: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    expect(
      await resultOf(member, 'conversation.updateChatRouting', {
        workspaceId: acme,
        chatId: chat,
        subagentPolicy: 'same_as_main',
        reasoningEffort: 'high',
      }),
    ).toEqual(isAllowed ? succeeded : missingPermission('session.configure'))
    expect(await chatRow(chat)).toMatchObject(
      isAllowed ? { subagentPolicy: 'same_as_main', reasoningEffort: 'high' } : { reasoningEffort: null },
    )
  },
)

test('an editor configures the session but where it runs stays the owner’s choice', async () => {
  const chat = await chatAs({ isPublic: false, roleId: 'editor', userId: bob })
  expect(
    await resultOf(bobInAcme, 'conversation.updateChatRouting', { workspaceId: acme, chatId: chat, runsOn: 'runtime' }),
  ).toEqual(failedWith('Only the owner changes how this session runs'))
})

test.each(chatAccessRows(readers))(
  'startRuntimeFromMessage needs chat.read on the source chat: $name',
  async ({ member, isAllowed, ...role }) => {
    const source = await chatAs(role, 'channel')
    const sourceMessage = await writtenMessage(source, alice)
    const started = `chat-${crypto.randomUUID()}`
    expect(
      await resultOf(member, 'conversation.startRuntimeFromMessage', {
        workspaceId: acme,
        id: `message-${crypto.randomUUID()}`,
        chatId: started,
        messageId: sourceMessage,
      }),
    ).toEqual(isAllowed ? succeeded : missingPermission('chat.read'))
    expect(await chatRow(started)).toEqual(
      isAllowed ? expect.objectContaining({ ownerUserId: member.userId }) : undefined,
    )
  },
)
