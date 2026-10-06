import { expect, test } from 'bun:test'
import { rebuildMessages } from '@hq/conversation/server'
import { events, jobs } from '@hq/db/postgres'
import { schema } from '@hq/db/zero'
import type { SandboxProvider } from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { startJobWorker } from './job-worker.ts'
import { acme, alice, aliceInAcme, openSharedTestApp, succeeded, waitFor } from './testing.ts'

const sharedTestApp = await openSharedTestApp()
const { database, eventsOf, changesOf } = sharedTestApp
const resultOf = (name: string, args: Record<string, unknown>) =>
  sharedTestApp.resultOf(aliceInAcme, name, { workspaceId: acme, ...args })
const succeeds = async (name: string, args: Record<string, unknown>) =>
  expect(await resultOf(name, args)).toEqual(succeeded)

const allMessages = () => database.query.messages.findMany({ orderBy: { workspaceId: 'asc', id: 'asc' } })
const rebuild = (scope: { workspaceId?: string; chatId?: string } = {}) =>
  zeroDrizzle(schema, database).transaction((tx) => rebuildMessages(tx, scope))
const expectGapFreeSeqs = async () => {
  const seqsByChat = Map.groupBy(
    await database.select().from(events),
    (event) => `${event.workspaceId}/${event.chatId}`,
  )
  for (const chatEvents of seqsByChat.values())
    expect(chatEvents.map((event) => event.seq).toSorted((first, second) => first - second)).toEqual(
      chatEvents.map((_, index) => index + 1),
    )
}

test('every chat change appends exactly one chat event at the next seq of the chat', async () => {
  await succeeds('workspace.createChat', {
    id: 'chat-events',
    name: 'Events',
    type: 'channel',
    projectId: 'project-billing',
  })
  await succeeds('conversation.sendMessage', { id: 'message-in-events', chatId: 'chat-events', text: 'Hello' })
  await succeeds('workspace.renameChat', { chatId: 'chat-events', name: 'Renamed' })
  await succeeds('workspace.moveChat', { chatId: 'chat-events', projectId: null })
  await succeeds('workspace.archiveChat', { chatId: 'chat-events' })
  expect(await changesOf('chat-events')).toEqual([
    {
      seq: 1,
      type: 'chat.created',
      actor: alice,
      payload: { name: 'Events', type: 'channel', projectId: 'project-billing' },
    },
    { seq: 2, type: 'message.posted', actor: alice, payload: expect.objectContaining({ body: 'Hello' }) },
    { seq: 3, type: 'chat.renamed', actor: alice, payload: { name: 'Renamed' } },
    { seq: 4, type: 'chat.moved', actor: alice, payload: { projectId: null } },
    { seq: 5, type: 'chat.archived', actor: alice, payload: {} },
  ])
})

test('deleting a project appends chat.archived or chat.moved for each of its chats', async () => {
  for (const [projectId, chatsPolicy] of [
    ['project-archived-chats', 'archive'],
    ['project-released-chats', 'release'],
  ] as const) {
    await succeeds('workspace.createProject', { id: projectId, name: projectId })
    await succeeds('workspace.createChat', { id: `chat-in-${projectId}`, name: 'In', type: 'channel', projectId })
    await succeeds('workspace.archiveProject', { projectId, chatsPolicy })
  }
  expect((await changesOf('chat-in-project-archived-chats')).slice(1)).toEqual([
    { seq: 2, type: 'chat.archived', actor: alice, payload: {} },
  ])
  expect((await changesOf('chat-in-project-released-chats')).slice(1)).toEqual([
    { seq: 2, type: 'chat.moved', actor: alice, payload: { projectId: null } },
  ])
})

test('chat events leave the messages projection unchanged', async () => {
  const before = await allMessages()
  await succeeds('workspace.renameChat', { chatId: 'chat-welcome', name: 'Hello' })
  await succeeds('workspace.moveChat', { chatId: 'chat-welcome', projectId: 'project-billing' })
  await succeeds('workspace.archiveChat', { chatId: 'chat-welcome' })
  expect((await eventsOf('chat-welcome')).slice(-3).map((event) => event.type)).toEqual([
    'chat.renamed',
    'chat.moved',
    'chat.archived',
  ])
  expect(await allMessages()).toEqual(before)
  await rebuild({ chatId: 'chat-welcome' })
  expect(await allMessages()).toEqual(before)
})

test('rebuilding the messages from the events reproduces the live projection, and twice changes nothing', async () => {
  await succeeds('conversation.sendMessage', { id: 'message-history-1', chatId: 'chat-standup', text: 'First' })
  await succeeds('conversation.editMessage', { messageId: 'message-history-1', text: 'First, edited' })
  await succeeds('conversation.sendMessage', { id: 'message-history-2', chatId: 'chat-standup', text: 'Second' })
  await succeeds('conversation.deleteMessage', { messageId: 'message-history-2' })
  await succeeds('conversation.sendMessage', { id: 'message-history-3', chatId: 'chat-invoice-bug', text: 'News?' })
  const agentBridge = createAgentBridge({
    sandboxProvider: {} as SandboxProvider,
    llm: { baseUrl: 'http://fake-llm.test/v1', model: 'openai/fake' },
  })
  const worker = startJobWorker(database, { pollIntervalMilliseconds: 20, agentBridge })
  await waitFor(async () => (await database.select().from(jobs)).every((job) => job.state === 'done'))
  await worker.stop()
  await succeeds('conversation.startRuntimeFromMessage', {
    id: 'message-history-seed',
    chatId: 'chat-history-runtime',
    messageId: 'message-history-1',
  })
  await succeeds('conversation.sendMessage', { id: 'message-history-4', chatId: 'chat-history-runtime', text: 'Go' })
  await succeeds('workspace.createChat', { id: 'chat-history', name: 'History', type: 'channel', projectId: null })
  await succeeds('conversation.sendMessage', { id: 'message-history-5', chatId: 'chat-history', text: 'Hi' })
  await succeeds('workspace.renameChat', { chatId: 'chat-history', name: 'History, renamed' })
  await succeeds('workspace.moveChat', { chatId: 'chat-history', projectId: 'project-billing' })
  await succeeds('workspace.archiveChat', { chatId: 'chat-history' })
  await succeeds('workspace.archiveProject', { projectId: 'project-billing', chatsPolicy: 'release' })
  await succeeds('workspace.archiveProject', { projectId: 'project-onboarding', chatsPolicy: 'archive' })
  const live = await allMessages()
  expect(live.find((message) => message.replyToId === 'message-history-3')).toMatchObject({ kind: 'notice' })
  expect(live.find((message) => message.id === 'message-history-2')).toMatchObject({ body: '' })

  await rebuild()
  expect(await allMessages()).toEqual(live)
  await rebuild()
  expect(await allMessages()).toEqual(live)
  await rebuild({ chatId: 'chat-standup' })
  await rebuild({ workspaceId: acme })
  expect(await allMessages()).toEqual(live)
  await expectGapFreeSeqs()
})

test('rebuilding repairs a drifted projection, only in the given scope', async () => {
  const live = await allMessages()
  await database.$client`update messages set body = 'drifted' where id in ('message-history-1', 'message-general-1')`
  await database.$client`delete from messages where id = 'message-history-4'`
  await database.$client`insert into messages (workspace_id, chat_id, id, seq, kind, author_id, body, created_at)
    values (${acme}, 'chat-standup', 'message-without-event', 999, 'member', ${alice}, 'Ghost', now())`
  await rebuild({ workspaceId: acme, chatId: 'chat-standup' })
  const afterChatRebuild = await allMessages()
  expect(afterChatRebuild.find((message) => message.id === 'message-history-1')?.body).toBe('First, edited')
  expect(afterChatRebuild.find((message) => message.id === 'message-without-event')).toBeUndefined()
  expect(afterChatRebuild.find((message) => message.id === 'message-history-4')).toBeUndefined()
  expect(afterChatRebuild.find((message) => message.id === 'message-general-1')?.body).toBe('drifted')
  await rebuild()
  expect(await allMessages()).toEqual(live)
})

test('concurrent message and chat changes get unique gap-free seqs per chat', async () => {
  const changes = Array.from({ length: 8 }, (_, index) => [
    resultOf('conversation.sendMessage', { id: `message-mixed-${index}`, chatId: 'chat-research', text: `${index}` }),
    resultOf('workspace.renameChat', { chatId: 'chat-research', name: `Research ${index}` }),
  ]).flat()
  expect(await Promise.all(changes)).toEqual(Array(16).fill(succeeded))
  expect((await eventsOf('chat-research')).filter((event) => event.type === 'chat.renamed')).toHaveLength(8)
  await expectGapFreeSeqs()
})
