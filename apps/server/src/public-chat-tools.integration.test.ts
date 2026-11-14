import { afterAll, afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import {
  acme,
  aliceInAcme,
  createFakeHosts,
  globex,
  lee,
  mcpCall,
  newChat,
  openSharedTestApp,
  replyTo,
  rpcOf,
  runtimeTurn,
  sendTo,
  succeeded,
  textOf,
} from './testing/testing.ts'

setDefaultTimeout(30_000)
const { database, port, resultOf } = await openSharedTestApp()
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port, database })
afterEach(() => disconnectFakeHosts())
afterAll(() => disconnectFakeHosts())

const word = `quokka${crypto.randomUUID().slice(0, 8)}`
const spyriaCall = async (host: Parameters<typeof mcpCall>[0], token: string, name: string, input: object) => {
  const { result } = await mcpCall(
    host,
    token,
    rpcOf('tools/call', { name, arguments: input }),
    {},
    undefined,
    '/mcp/spyria',
  )
  return { text: textOf(result), isError: result.isError }
}
const newMessage = async (chatId: string, text: string, member = aliceInAcme) => {
  const id = `message-${crypto.randomUUID()}`
  expect(await sendTo(member, chatId, id, text)).toEqual(succeeded)
  return id
}
const writtenAgentActivity = async (chatId: string, seq: number, kind: 'member' | 'agent' | 'step', body: string) => {
  const authorId = kind === 'member' ? aliceInAcme.userId : null
  await database.$client`
    insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, ${chatId}, ${`message-${crypto.randomUUID()}`}, ${seq}, ${kind}, ${authorId}, ${body}, now())`
}

const seededChats = async () => {
  const channel = await newChat({ type: 'channel' })
  const aiChat = await newChat({ type: 'runtime', visibility: 'public' })
  const privateChannel = await newChat({ type: 'channel', visibility: 'private' })
  const archivedChannel = await newChat({ type: 'channel' })
  const root = await newMessage(channel, `The ${word} launch is on Friday`)
  const threadReply = `message-${crypto.randomUUID()}`
  expect(await replyTo(aliceInAcme, channel, root, threadReply)).toEqual(succeeded)
  const deleted = await newMessage(channel, `Deleted ${word} note`)
  expect(await resultOf(aliceInAcme, 'conversation.deleteMessage', { workspaceId: acme, messageId: deleted })).toEqual(
    succeeded,
  )
  await writtenAgentActivity(aiChat, 1, 'member', `Ask the agent about ${word}`)
  await writtenAgentActivity(aiChat, 2, 'step', `Step ${word} command`)
  await writtenAgentActivity(aiChat, 3, 'agent', `The agent answers about ${word}`)
  await newMessage(privateChannel, `Private ${word} salaries`)
  await newMessage(archivedChannel, `Archived ${word} plan`)
  await database.$client`update chats set archived = true where id = ${archivedChannel}`
  await newMessage('chat-general', `Globex ${word} secret`, { workspaceId: globex, userId: aliceInAcme.userId })
  return { channel, aiChat, privateChannel, archivedChannel, root, threadReply }
}

test('an agent lists, searches and reads the public channels and AI chats of its workspace, and never a private, archived or other workspace’s chat, even one its prompter is in', async () => {
  const chats = await seededChats()
  const host = await fakeHost('Public chats host')
  const { chatId, token } = await runtimeTurn(host, aliceInAcme.userId)

  const listed = await mcpCall(host, token, rpcOf('tools/list'), {}, undefined, '/mcp/spyria')
  expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
    'open_page',
    'take_screenshot',
    'list_public_chats',
    'search_public_chats',
    'read_public_chat',
  ])

  const list = await spyriaCall(host, token, 'list_public_chats', {})
  expect(list.isError).toBe(false)
  expect(list.text).toContain(`(channel, id ${chats.channel})`)
  expect(list.text).toContain(`(AI chat, id ${chats.aiChat})`)
  for (const hidden of [chats.privateChannel, chats.archivedChannel, 'chat-general'])
    expect(list.text).not.toContain(hidden)
  const aiChatsOnly = await spyriaCall(host, token, 'list_public_chats', { kind: 'ai_chat' })
  expect(aiChatsOnly.text).toContain(chats.aiChat)
  expect(aiChatsOnly.text).not.toContain(chats.channel)

  const search = await spyriaCall(host, token, 'search_public_chats', { query: word.toUpperCase() })
  expect(search.isError).toBe(false)
  expect(search.text).toContain(`The ${word} launch is on Friday`)
  expect(search.text).toContain(`Ask the agent about ${word}`)
  expect(search.text).toContain('Agent at')
  for (const hidden of ['Deleted', 'Step', 'Private', 'Archived', 'Globex'])
    expect(search.text).not.toContain(`${hidden} ${word}`)
  const searchedIn = await spyriaCall(host, token, 'search_public_chats', { query: word, chatId: chats.aiChat })
  expect(searchedIn.text).toContain(`Ask the agent about ${word}`)
  expect(searchedIn.text).not.toContain('launch')

  const read = await spyriaCall(host, token, 'read_public_chat', { chatId: chats.channel })
  expect(read.isError).toBe(false)
  expect(read.text).toContain(`[${chats.root}] Alice`)
  expect(read.text).toContain(`(1 reply in its thread: threadId ${chats.root})`)
  expect(read.text).not.toContain('Deleted')
  const thread = await spyriaCall(host, token, 'read_public_chat', { chatId: chats.channel, threadId: chats.root })
  expect(thread.text).toContain(`[${chats.threadReply}] Alice`)
  expect(thread.text).toContain('In the thread')
  const aiChatRead = await spyriaCall(host, token, 'read_public_chat', { chatId: chats.aiChat })
  expect(aiChatRead.text).toContain('Alice at')
  expect(aiChatRead.text).toContain('Agent at')
  expect(aiChatRead.text).toContain(`The agent answers about ${word}`)
  expect(aiChatRead.text).not.toContain('Step')
  const earlier = await spyriaCall(host, token, 'read_public_chat', { chatId: chats.channel, before: chats.root })
  expect(earlier.text).toContain('no messages before this one')

  const refusal = 'No public chat of this workspace has this id; list them with list_public_chats'
  for (const hidden of [chats.privateChannel, chats.archivedChannel, 'chat-general', chatId]) {
    expect(await spyriaCall(host, token, 'read_public_chat', { chatId: hidden })).toEqual({
      text: refusal,
      isError: true,
    })
    expect(await spyriaCall(host, token, 'search_public_chats', { query: word, chatId: hidden })).toEqual({
      text: refusal,
      isError: true,
    })
  }
  expect(
    await spyriaCall(host, token, 'read_public_chat', { chatId: chats.channel, before: 'message-unknown' }),
  ).toEqual({
    text: 'No message of this chat has the id given in before',
    isError: true,
  })

  const calls = await database.$client`
    select distinct tool, read_only from tool_calls where chat_id = ${chatId} and server = 'spyria' order by tool`
  expect(calls.map(({ tool, read_only }) => ({ tool, readOnly: read_only }))).toEqual([
    { tool: 'list_public_chats', readOnly: true },
    { tool: 'read_public_chat', readOnly: true },
    { tool: 'search_public_chats', readOnly: true },
  ])
})

test('the public chat tools refuse a turn whose prompter has left the workspace', async () => {
  const host = await fakeHost('Removed prompter host')
  const { token } = await runtimeTurn(host, lee)
  await database.$client`update memberships set removed_at = now() where workspace_id = ${acme} and user_id = ${lee}`
  try {
    for (const [name, input] of [
      ['list_public_chats', {}],
      ['search_public_chats', { query: word }],
      ['read_public_chat', { chatId: 'chat-standup' }],
    ] as const)
      expect(await spyriaCall(host, token, name, input)).toEqual({
        text: 'The member who prompted is no longer in this workspace',
        isError: true,
      })
  } finally {
    await database.$client`update memberships set removed_at = null where workspace_id = ${acme} and user_id = ${lee}`
  }
})
