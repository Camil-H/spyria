import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  chatAccessRows,
  chatAs,
  failedWith,
  globex,
  messageRow,
  newChat,
  openSharedTestApp,
  posters,
  readers,
  sessionTokenOf,
  succeeded,
} from './testing/testing.ts'

const { app, database, resultOf, changesOf } = await openSharedTestApp()

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82])
const upload = async (userId: string, chat: string, content: Uint8Array<ArrayBuffer>, name = 'chart.png') => {
  const response = await app.request(`/api/chats/${chat}/attachments?${new URLSearchParams({ name })}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}` },
    body: content,
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
const download = async (userId: string, chat: string, attachmentId: string) =>
  app.request(`/api/chats/${chat}/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, acme, userId)}` },
  })
const storedCount = async () =>
  Number((await database.$client`select count(*)::int as count from message_attachments`)[0]?.count)
const sendWith = (member: typeof aliceInAcme, chat: string, attachments: object[], text = 'See attached') => {
  const id = `message-${crypto.randomUUID()}`
  return resultOf(member, 'conversation.sendMessage', { workspaceId: acme, id, chatId: chat, text, attachments }).then(
    (result) => ({ id, result }),
  )
}

test.each(chatAccessRows(posters))(
  'uploading an attachment needs chat.post: $name',
  async ({ userId, isAllowed, ...role }) => {
    const chat = await chatAs({ userId, ...role }, 'channel')
    const before = await storedCount()
    const uploaded = await upload(userId, chat, png)
    expect(uploaded.status).toBe(isAllowed ? 201 : 403)
    if (isAllowed)
      expect(uploaded.body).toEqual({
        id: expect.any(String),
        name: 'chart.png',
        mediaType: 'image/png',
        size: png.length,
      })
    expect(await storedCount()).toBe(before + (isAllowed ? 1 : 0))
  },
)

test.each([
  ['an SVG named as a PNG', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
  ['an HTML page', new TextEncoder().encode('<!doctype html><script>alert(1)</script>')],
  ['an empty file', new Uint8Array()],
])('an upload of %s is refused by its content and stores nothing', async (_, content) => {
  const chat = await newChat({ type: 'channel' })
  const before = await storedCount()
  expect(await upload(alice, chat, content)).toEqual({
    status: 415,
    body: { error: 'attachment_not_allowed', message: 'Attach an image, a sound, a video or a PDF of up to 20 MB' },
  })
  expect(await storedCount()).toBe(before)
})

test('an upload over 20 MB is refused before it is stored', async () => {
  const chat = await newChat({ type: 'channel' })
  const oversized = new Uint8Array(20 * 1024 * 1024 + 1)
  oversized.set(png)
  const before = await storedCount()
  expect((await upload(alice, chat, oversized)).status).toBe(413)
  expect(await storedCount()).toBe(before)
})

test('a sent attachment keeps the server-checked name, type and size, never the ones the client claims', async () => {
  const chat = await newChat({ type: 'channel' })
  const { body } = await upload(alice, chat, png, '../../secret/chart.png')
  const claimed = { id: body.id, name: 'evil.html', mediaType: 'text/html', size: 1 }
  const { id, result } = await sendWith(aliceInAcme, chat, [claimed])
  expect(result).toEqual(succeeded)
  const stored = { id: body.id, name: 'chart.png', mediaType: 'image/png', size: png.length }
  expect(await messageRow(id)).toEqual(expect.objectContaining({ body: 'See attached', attachments: [stored] }))
  expect((await changesOf(chat)).at(-1)?.payload).toEqual(expect.objectContaining({ attachments: [stored] }))
})

test('a message can carry only attachments, without text', async () => {
  const chat = await newChat({ type: 'channel' })
  const { body } = await upload(alice, chat, png)
  const { id, result } = await sendWith(aliceInAcme, chat, [body], '   ')
  expect(result).toEqual(succeeded)
  expect(await messageRow(id)).toEqual(expect.objectContaining({ body: '', attachments: [body] }))
})

test.each([
  ['an upload of another member', async (chat: string) => (await upload(bob, chat, png)).body],
  ['an upload to another chat', async () => (await upload(alice, await newChat({ type: 'channel' }), png)).body],
  [
    'an upload already sent',
    async (chat: string) => {
      const { body } = await upload(alice, chat, png)
      await sendWith(aliceInAcme, chat, [body])
      return body
    },
  ],
  ['an unknown upload', async () => ({ id: 'attachment-missing', name: 'x.png', mediaType: 'image/png', size: 1 })],
])('sending %s is refused and posts nothing', async (_, attachmentOf) => {
  const chat = await newChat({ type: 'channel', participants: [{ memberId: bob, roleId: 'prompter' }] })
  const attachment = await attachmentOf(chat)
  const { id, result } = await sendWith(aliceInAcme, chat, [attachment])
  expect(result).toEqual(failedWith('This attachment is no longer available'))
  expect(await messageRow(id)).toBeUndefined()
})

test('more than six attachments on one message are refused', async () => {
  const chat = await newChat({ type: 'channel' })
  const uploads = await Promise.all(Array.from({ length: 7 }, async () => (await upload(alice, chat, png)).body))
  const { id, result } = await sendWith(aliceInAcme, chat, uploads)
  expect(result).toEqual(expect.objectContaining({ error: expect.any(String) }))
  expect(await messageRow(id)).toBeUndefined()
})

test.each(chatAccessRows(readers))(
  'a sent attachment is served to readers of its chat only, as an inert file: $name',
  async ({ userId, isAllowed, ...role }) => {
    const chat = await chatAs({ userId, ...role }, 'channel')
    const { body } = await upload(alice, chat, png)
    await sendWith(aliceInAcme, chat, [body])
    const response = await download(userId, chat, String(body.id))
    expect(response.status).toBe(isAllowed ? 200 : 403)
    if (!isAllowed) return
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png)
    expect(Object.fromEntries(response.headers)).toEqual(
      expect.objectContaining({
        'content-type': 'image/png',
        'content-disposition': "inline; filename*=UTF-8''chart.png",
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
      }),
    )
  },
)

test('an attachment is not served before it is sent, through another chat, or after its message is deleted', async () => {
  const chat = await newChat({ type: 'channel' })
  const { body } = await upload(alice, chat, png)
  expect((await download(alice, chat, String(body.id))).status).toBe(404)
  const { id } = await sendWith(aliceInAcme, chat, [body])
  const otherChat = await newChat({ type: 'channel' })
  expect((await download(alice, otherChat, String(body.id))).status).toBe(404)
  expect((await download(alice, chat, String(body.id))).status).toBe(200)
  expect(await resultOf(aliceInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: id })).toEqual(
    succeeded,
  )
  expect((await download(alice, chat, String(body.id))).status).toBe(404)
  expect(await messageRow(id)).toEqual(expect.objectContaining({ body: '', attachments: [] }))
  expect(
    (await database.$client`select 1 from message_attachments where workspace_id = ${acme} and id = ${String(body.id)}`)
      .length,
  ).toBe(0)
})

test('a session in another workspace cannot read an attachment, even of a member of both', async () => {
  const chat = await newChat({ type: 'channel' })
  const { body } = await upload(alice, chat, png)
  await sendWith(aliceInAcme, chat, [body])
  const response = await app.request(`/api/chats/${chat}/attachments/${String(body.id)}`, {
    headers: { authorization: `Bearer ${await sessionTokenOf(database, globex, alice)}` },
  })
  expect(response.status).toBe(403)
})
