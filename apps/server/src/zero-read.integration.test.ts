import { expect, test } from 'bun:test'
import { conversationMutators } from '@spyria/conversation/server'
import { createMockSnapshot, type Snapshot } from '@spyria/db'
import { pinnedStepTypes } from '@spyria/db/zero-queries'
import { createZeroStore, type ScopedQueryName } from '@spyria/db/zero-store'
import { type ChatId, chatId, type MemberId, messageId, type WorkspaceId } from '@spyria/kernel'
import { workspaceMutators } from '@spyria/workspace/server'
import {
  acme,
  alice,
  bob,
  globex,
  lee,
  newChat,
  openSharedTestApp,
  openZeroStore,
  rejectionOf,
  waitFor,
  zeroSessionsOf,
} from './testing/testing.ts'

const { database } = await openSharedTestApp()
await database.$client`delete from workspace_connections`

const collectionsInStoredOrder = ['messages', 'terminalLines', 'toolConnections']

const visibleTo = (snapshot: Snapshot, viewerId: MemberId, workspaceIds: readonly WorkspaceId[]): Snapshot => {
  const inWorkspaces = <Row extends { workspaceId: WorkspaceId }>(rows: readonly Row[]) =>
    rows.filter((row) => workspaceIds.includes(row.workspaceId))
  const ownedByViewer = <Row extends { workspaceId: WorkspaceId; memberId: MemberId }>(rows: readonly Row[]) =>
    inWorkspaces(rows).filter((row) => row.memberId === viewerId)
  const keyOf = (workspaceId: WorkspaceId, chatId: ChatId) => `${workspaceId}/${chatId}`
  const participations = new Set(
    snapshot.chatMembers.filter((row) => row.memberId === viewerId).map((row) => keyOf(row.workspaceId, row.chatId)),
  )
  const readableChats = inWorkspaces(snapshot.chats).filter(
    (chat) => chat.visibility === 'public' || participations.has(keyOf(chat.workspaceId, chat.id)),
  )
  const readableChatKeys = new Set(readableChats.map((chat) => keyOf(chat.workspaceId, chat.id)))
  const inReadableChats = <Row extends { workspaceId: WorkspaceId; chatId: ChatId }>(rows: readonly Row[]) =>
    rows.filter((row) => readableChatKeys.has(keyOf(row.workspaceId, row.chatId)))
  const readableMessages = inReadableChats(snapshot.messages)
  const latestMessages = readableChats.flatMap((chat) =>
    readableMessages
      .filter(
        (message) =>
          message.chatId === chat.id &&
          message.workspaceId === chat.workspaceId &&
          (message.kind === 'member' || message.kind === 'agent') &&
          message.deletedAt === null &&
          message.threadRootId === null &&
          message.authorId !== viewerId,
      )
      .toSorted((first, second) => second.seq - first.seq)
      .slice(0, 1)
      .map((message) => ({ ...message, needsReply: false })),
  )
  const readableChatOwners = new Set(readableChats.map((chat) => `${chat.workspaceId}/${chat.ownerId}`))
  const ownedByViewerOrReadableChatOwner = <Row extends { workspaceId: WorkspaceId; memberId: MemberId }>(
    rows: readonly Row[],
  ) =>
    inWorkspaces(rows).filter(
      (row) => row.memberId === viewerId || readableChatOwners.has(`${row.workspaceId}/${row.memberId}`),
    )
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.filter((workspace) => workspaceIds.includes(workspace.id)),
    memberships: inWorkspaces(snapshot.memberships),
    workspaceRoles: inWorkspaces(snapshot.workspaceRoles),
    projects: inWorkspaces(snapshot.projects),
    chats: readableChats,
    chatRoles: inWorkspaces(snapshot.chatRoles),
    messages: readableMessages,
    latestMessages,
    pinnedSteps: readableMessages
      .filter((message) => message.kind === 'step' && pinnedStepTypes.includes(message.body))
      .map((message) => ({ ...message, needsReply: false })),
    browserPages: inReadableChats(snapshot.browserPages),
    usageEntries: inReadableChats(snapshot.usageEntries),
    sources: inReadableChats(snapshot.sources),
    chatMembers: inReadableChats(snapshot.chatMembers),
    readMarkers: inReadableChats(ownedByViewer(snapshot.readMarkers)),
    threadReadMarkers: inReadableChats(ownedByViewer(snapshot.threadReadMarkers)),
    llmCredentials: ownedByViewer(snapshot.llmCredentials),
    workspaceConnections: inWorkspaces(snapshot.workspaceConnections),
    toolConnections: ownedByViewerOrReadableChatOwner(snapshot.toolConnections),
  }
}

const canonical = (row: unknown) =>
  JSON.stringify(Object.entries(row as object).sort(([first], [second]) => first.localeCompare(second)))
const normalized = (snapshot: Snapshot) =>
  Object.fromEntries(
    Object.entries(snapshot).map(([name, rows]) => [
      name,
      collectionsInStoredOrder.includes(name)
        ? (rows as unknown as { chatId?: string }[]).toSorted((first, second) =>
            (first.chatId ?? '').localeCompare(second.chatId ?? ''),
          )
        : (rows as unknown[]).toSorted((first, second) => canonical(first).localeCompare(canonical(second))),
    ]),
  )

const expectedFor = (viewerId: MemberId, workspaceIds: readonly WorkspaceId[]) =>
  normalized(visibleTo(createMockSnapshot(), viewerId, workspaceIds))
type ZeroStore = Awaited<ReturnType<typeof openZeroStore<ReturnType<typeof createZeroStore>>>>
const chatQueries = (chatId: string): [ScopedQueryName, Record<string, string | number>][] => [
  ['chatMessages', { chatId, limit: 1000 }],
  ['chatPinnedSteps', { chatId }],
  ['chatBrowserPages', { chatId }],
  ['chatUsage', { chatId }],
]
const watchChats = async (store: ZeroStore, workspaceId: WorkspaceId, chatIds: readonly string[]) => {
  const watched = chatIds.flatMap(chatQueries)
  for (const [name, args] of watched) store.watch(workspaceId, name, args)
  await waitFor(() => watched.every(([name, args]) => store.scopedStatus(workspaceId, name, args)?.isComplete))
}
const watchReadableChats = (store: ZeroStore) =>
  Promise.all(
    store.read().workspaces.map((workspace) =>
      watchChats(
        store,
        workspace.id,
        store
          .read()
          .chats.filter((chat) => chat.workspaceId === workspace.id)
          .map((chat) => chat.id),
      ),
    ),
  )
const replicaWatcher = await openZeroStore(createZeroStore, alice, [acme, globex])
await watchReadableChats(replicaWatcher)
await waitFor(() => Bun.deepEquals(normalized(replicaWatcher.read()), expectedFor(alice, [acme, globex])))

test.each([
  { viewer: 'Alice', viewerId: alice, workspaceIds: [acme, globex] },
  { viewer: 'Bob', viewerId: bob, workspaceIds: [acme] },
  { viewer: 'Lee', viewerId: lee, workspaceIds: [acme] },
])('$viewer reads through Zero exactly the mock snapshot visible to them', async ({ viewerId, workspaceIds }) => {
  const store = await openZeroStore(createZeroStore, viewerId, workspaceIds)
  await watchReadableChats(store)
  expect(normalized(store.read())).toEqual(expectedFor(viewerId, workspaceIds))
})

test.each([
  {
    viewer: 'Alice, prompter on Setup helper',
    viewerId: alice,
    chats: ['Welcome', 'Setup helper', 'Invoice bug', 'Standup', 'Research'],
  },
  {
    viewer: 'Bob, prompter on Invoice bug',
    viewerId: bob,
    chats: ['Welcome', 'Setup helper', 'Invoice bug', 'Standup'],
  },
  { viewer: 'Lee, reader on Invoice bug', viewerId: lee, chats: ['Welcome', 'Invoice bug', 'Standup'] },
])(
  '$viewer reads the public channels and the private chats they take part in, nothing of the others',
  async ({ viewerId, chats }) => {
    const store = await openZeroStore(createZeroStore, viewerId, [acme])
    await watchChats(store, acme, [
      'chat-welcome',
      'chat-setup-helper',
      'chat-invoice-bug',
      'chat-standup',
      'chat-research',
    ])
    const read = store.read()
    expect(read.chats.map((chat) => chat.name)).toEqual([...chats])
    const readableChatIds = new Set<string>(read.chats.map((chat) => chat.id))
    const chatIdsOf = (rows: readonly { chatId: string }[]) => rows.map((row) => row.chatId)
    for (const rows of [
      read.messages,
      read.latestMessages,
      read.pinnedSteps,
      read.chatMembers,
      read.usageEntries,
      read.browserPages,
    ])
      expect(chatIdsOf(rows).filter((id) => !readableChatIds.has(id))).toEqual([])
    expect(read.messages.length).toBeGreaterThan(0)
    expect(read.chatRoles.map((role) => role.id)).toEqual(['editor', 'owner', 'prompter', 'reader'])
  },
)

test('a participant row added to a private chat syncs it with its rows, and removing it takes them away', async () => {
  const store = await openZeroStore(createZeroStore, bob, [acme])
  const researchOf = () => store.read().chats.filter((chat) => chat.id === 'chat-research')
  expect(researchOf()).toEqual([])
  await database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, 'chat-research', ${bob}, 'reader')`
  await waitFor(() => researchOf().length === 1)
  await database.$client`delete from chat_participants where chat_id = 'chat-research' and user_id = ${bob}`
  await waitFor(
    () => researchOf().length === 0 && store.read().chatMembers.every((row) => row.chatId !== 'chat-research'),
  )
})

test('signing out of a workspace removes its rows but keeps it listed, signing in brings them back', async () => {
  const store = await openZeroStore(createZeroStore, alice, [acme, globex])
  await store.signOut(globex)
  expect(store.signedInWorkspaceIds()).toEqual(new Set([acme]))
  expect(store.read().chats.filter((chat) => chat.workspaceId === globex)).toEqual([])
  expect(store.read().workspaces.map((workspace) => workspace.name)).toEqual(['Acme', 'Globex'])
  const signedOut = await rejectionOf(
    store.mutate(
      globex,
      workspaceMutators.workspace.createProject({ workspaceId: globex, id: 'project-signed-out', name: 'Signed out' }),
    ),
  )
  expect(signedOut.message).toContain('Workspace workspace-globex is not open')
  const [globexSession] = await zeroSessionsOf(alice, [globex])
  if (!globexSession) throw new Error('Alice has no Globex session')
  await store.signIn(globexSession)
  expect(store.signedInWorkspaceIds()).toEqual(new Set([acme, globex]))
  expect(store.read().chats.filter((chat) => chat.workspaceId === globex).length).toBe(2)
})

test('a mutation through the store reaches the replica and, once the server confirms, Postgres', async () => {
  const store = await openZeroStore(createZeroStore, alice, [acme])
  const { confirmation } = await store.mutate(
    acme,
    workspaceMutators.workspace.createProject({ workspaceId: acme, id: 'project-stored', name: 'Stored' }),
  )
  await confirmation
  expect(
    store
      .read()
      .projects.filter((project) => project.workspaceId === acme)
      .map((project) => project.name),
  ).toEqual(['Onboarding', 'Billing', 'Stored'])
  expect(await database.query.projects.findFirst({ where: { id: 'project-stored' } })).toMatchObject({
    workspaceId: acme,
    name: 'Stored',
  })
})

test('an optimistic message takes the next seq of its chat before the server confirms it', async () => {
  const store = await openZeroStore(createZeroStore, alice, [acme])
  await watchChats(store, acme, ['chat-invoice-bug'])
  const { confirmation } = await store.mutate(
    acme,
    conversationMutators.conversation.sendMessage({
      workspaceId: acme,
      id: 'message-optimistic',
      chatId: 'chat-invoice-bug',
      text: 'Optimistic',
    }),
  )
  await Bun.sleep(0)
  const invoiceMessages = store.read().messages.filter((message) => message.chatId === 'chat-invoice-bug')
  expect(invoiceMessages.at(-1)).toMatchObject({ id: 'message-optimistic', seq: 5 })
  await confirmation
})

test('the client refuses a mutation the member lacks the permission for, before it reaches the server', async () => {
  const store = await openZeroStore(createZeroStore, lee, [acme])
  const refused = await rejectionOf(
    store.mutate(
      acme,
      conversationMutators.conversation.sendMessage({
        workspaceId: acme,
        id: 'message-reader-posts',
        chatId: 'chat-invoice-bug',
        text: 'Readers cannot post',
      }),
    ),
  )
  expect(refused.message).toContain('You need the chat.post permission on this chat')
  expect(store.read().messages.some((message) => message.id === 'message-reader-posts')).toBe(false)
  expect(await database.query.messages.findFirst({ where: { id: 'message-reader-posts' } })).toBeUndefined()
})

test('posting in a public channel through the client joins the member as Prompter in the replica and in Postgres', async () => {
  const store = await openZeroStore(createZeroStore, lee, [acme])
  const { confirmation } = await store.mutate(
    acme,
    conversationMutators.conversation.sendMessage({
      workspaceId: acme,
      id: 'message-lee-joins-welcome',
      chatId: 'chat-welcome',
      text: 'Hello all',
    }),
  )
  const leeInWelcome = (rows: readonly { chatId: string; memberId: string; roleId: string }[]) =>
    rows.filter((row) => row.chatId === 'chat-welcome' && row.memberId === lee).map((row) => row.roleId)
  expect(leeInWelcome(store.read().chatMembers)).toEqual(['prompter'])
  await confirmation
  expect(
    await database.$client`select role_id from chat_participants where chat_id = 'chat-welcome' and user_id = ${lee}`,
  ).toEqual([{ role_id: 'prompter' }] as never)
})

test('archiving a project whose chats the member cannot all administer is applied on the client, refused by the server and rolled back', async () => {
  await database.$client`update chats set project_id = 'project-onboarding' where id = 'chat-research'`
  const store = await openZeroStore(createZeroStore, bob, [acme])
  const onboardingOf = () => store.read().projects.find((project) => project.id === 'project-onboarding')
  await database.$client`update chat_participants set role_id = 'owner' where user_id = ${bob} and chat_id = 'chat-welcome'`
  await waitFor(() =>
    store
      .read()
      .chatMembers.some((row) => row.chatId === 'chat-welcome' && row.memberId === bob && row.roleId === 'owner'),
  )
  const { confirmation } = await store.mutate(
    acme,
    workspaceMutators.workspace.archiveProject({
      workspaceId: acme,
      projectId: 'project-onboarding',
      chatsPolicy: 'archive',
    }),
  )
  expect((await rejectionOf(confirmation)).message).toContain('You need the chat.admin permission on this chat')
  await waitFor(() => onboardingOf()?.archived === false)
  expect(await database.query.projects.findFirst({ where: { id: 'project-onboarding' } })).toMatchObject({
    archived: false,
  })
})

test('a member invited through the client gets the chat in his replica, and loses it when removed', async () => {
  const chat = await newChat()
  const aliceStore = await openZeroStore(createZeroStore, alice, [acme])
  const bobStore = await openZeroStore(createZeroStore, bob, [acme])
  const bobSees = () => bobStore.read().chats.some((row) => row.id === chat)
  await waitFor(() => aliceStore.read().chats.some((row) => row.id === chat))
  expect(bobSees()).toBe(false)
  const memberChange = { workspaceId: acme, chatId: chat, memberId: bob }
  await (
    await aliceStore.mutate(acme, conversationMutators.conversation.inviteMember({ ...memberChange, roleId: 'reader' }))
  ).confirmation
  await waitFor(bobSees)
  await (await aliceStore.mutate(acme, conversationMutators.conversation.removeMember(memberChange))).confirmation
  await waitFor(() => !bobSees() && bobStore.read().chatMembers.every((row) => row.chatId !== chat))
})

test('a private channel reaches only its participants; one made private through the client leaves the replicas of those who did not join', async () => {
  const aliceStore = await openZeroStore(createZeroStore, alice, [acme])
  const bobStore = await openZeroStore(createZeroStore, bob, [acme])
  const leeStore = await openZeroStore(createZeroStore, lee, [acme])
  const sees = (store: typeof aliceStore, chat: string) => () => store.read().chats.some((row) => row.id === chat)
  const createChannel = async (id: string, visibility: 'public' | 'private') =>
    (
      await aliceStore.mutate(
        acme,
        workspaceMutators.workspace.createChat({
          workspaceId: acme,
          id,
          name: id,
          type: 'channel',
          visibility,
          projectId: null,
        }),
      )
    ).confirmation
  const backroom = `chat-${crypto.randomUUID()}`
  const lounge = `chat-${crypto.randomUUID()}`
  await createChannel(backroom, 'private')
  await createChannel(lounge, 'public')
  await waitFor(() => sees(leeStore, lounge)() && sees(bobStore, lounge)())
  expect(sees(leeStore, backroom)()).toBe(false)
  expect(sees(bobStore, backroom)()).toBe(false)
  await (
    await bobStore.mutate(acme, conversationMutators.conversation.joinChannel({ workspaceId: acme, chatId: lounge }))
  ).confirmation
  const changeVisibility = (visibility: 'public' | 'private') =>
    aliceStore.mutate(
      acme,
      workspaceMutators.workspace.changeVisibility({ workspaceId: acme, chatId: lounge, visibility }),
    )
  await (await changeVisibility('private')).confirmation
  await waitFor(() => !sees(leeStore, lounge)())
  expect(sees(bobStore, lounge)()).toBe(true)
  await (await changeVisibility('public')).confirmation
  await waitFor(sees(leeStore, lounge))
})

test('a member’s thread read markers reach only his replica, and only for the chats he can read', async () => {
  const chat = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: lee, roleId: 'reader' }],
  })
  const aliceStore = await openZeroStore(createZeroStore, alice, [acme])
  const leeStore = await openZeroStore(createZeroStore, lee, [acme])
  await waitFor(() => leeStore.read().chats.some((row) => row.id === chat))
  await watchChats(aliceStore, acme, [chat])
  const post = (fields: { id: string; threadRootId?: string }) =>
    aliceStore.mutate(
      acme,
      conversationMutators.conversation.sendMessage({ workspaceId: acme, chatId: chat, text: 'Hi', ...fields }),
    )
  await (await post({ id: `${chat}-root` })).confirmation
  await (await post({ id: `${chat}-reply`, threadRootId: `${chat}-root` })).confirmation
  await watchChats(leeStore, acme, [chat])
  await waitFor(() => leeStore.read().messages.some((row) => row.id === `${chat}-reply`))
  await (
    await leeStore.mutate(
      acme,
      conversationMutators.conversation.markThreadRead({
        workspaceId: acme,
        chatId: chat,
        threadRootId: `${chat}-root`,
      }),
    )
  ).confirmation
  const markersOf = (store: typeof aliceStore) =>
    store
      .read()
      .threadReadMarkers.filter((row) => row.chatId === chat)
      .map(({ memberId, lastReadSeq }) => ({ memberId, lastReadSeq }))
  await waitFor(() => markersOf(leeStore).length === 1)
  expect(markersOf(leeStore)).toEqual([{ memberId: lee, lastReadSeq: 2 }])
  expect(markersOf(aliceStore)).toEqual([])
  await database.$client`delete from chat_participants where chat_id = ${chat} and user_id = ${lee}`
  await waitFor(() => markersOf(leeStore).length === 0)
  expect(
    await database.$client`select last_read_seq from thread_read_markers where chat_id = ${chat} and user_id = ${lee}`,
  ).toEqual([{ last_read_seq: 2 }] as never)
})

test('a runtime’s origin reaches the readers of its source channel without its private runtime chat, and leaves with the channel', async () => {
  const channel = await newChat({
    type: 'channel',
    visibility: 'private',
    participants: [{ memberId: lee, roleId: 'reader' }],
  })
  const aliceStore = await openZeroStore(createZeroStore, alice, [acme])
  const leeStore = await openZeroStore(createZeroStore, lee, [acme])
  const bobStore = await openZeroStore(createZeroStore, bob, [acme])
  await watchChats(aliceStore, acme, [channel])
  await (
    await aliceStore.mutate(
      acme,
      conversationMutators.conversation.sendMessage({
        workspaceId: acme,
        id: `${channel}-root`,
        chatId: channel,
        text: 'Hi',
      }),
    )
  ).confirmation
  const runtime = `chat-${crypto.randomUUID()}`
  await (
    await aliceStore.mutate(
      acme,
      conversationMutators.conversation.startRuntimeFromMessage({
        workspaceId: acme,
        id: `${runtime}-seed`,
        chatId: runtime,
        messageId: `${channel}-root`,
      }),
    )
  ).confirmation
  const originsOf = (store: typeof aliceStore) =>
    store
      .read()
      .runtimeOrigins.filter((row) => row.chatId === channel)
      .map(({ runtimeChatId, messageId, startedBy }) => ({ runtimeChatId, messageId, startedBy }))
  const origin = { runtimeChatId: chatId(runtime), messageId: messageId(`${channel}-root`), startedBy: alice }
  await waitFor(() => originsOf(leeStore).length === 1)
  expect(originsOf(leeStore)).toEqual([origin])
  expect(originsOf(aliceStore)).toEqual([origin])
  expect(leeStore.read().chats.some((row) => row.id === runtime)).toBe(false)
  expect(originsOf(bobStore)).toEqual([])
  await database.$client`delete from chat_participants where chat_id = ${channel} and user_id = ${lee}`
  await waitFor(() => originsOf(leeStore).length === 0)
})

test('a member watching a chat he cannot read receives none of its messages, steps, pages or usage until he joins it', async () => {
  const chat = await newChat({ type: 'channel', visibility: 'private' })
  const aliceStore = await openZeroStore(createZeroStore, alice, [acme])
  await waitFor(() => aliceStore.read().chats.some((row) => row.id === chat))
  await (
    await aliceStore.mutate(
      acme,
      conversationMutators.conversation.sendMessage({
        workspaceId: acme,
        id: `${chat}-hello`,
        chatId: chat,
        text: 'Hi',
      }),
    )
  ).confirmation
  await database.$client`
    insert into usage_entries (workspace_id, chat_id, month, user_id, tokens, cost_micros, calls)
    values (${acme}, ${chat}, ${new Date().toISOString().slice(0, 7)}, ${alice}, 10, 1000, 1)`
  await database.$client`
    insert into browser_pages (workspace_id, chat_id, url, title, body_text) values (${acme}, ${chat}, 'u', 't', 'Secret')`
  const bobStore = await openZeroStore(createZeroStore, bob, [acme])
  await watchChats(bobStore, acme, [chat])
  bobStore.watch(acme, 'monthUsage', { month: new Date().toISOString().slice(0, 7) })
  const rowsOfChat = () => {
    const read = bobStore.read()
    return [read.messages, read.latestMessages, read.pinnedSteps, read.browserPages, read.usageEntries]
      .flat()
      .filter((row) => row.chatId === chat).length
  }
  await waitFor(
    () =>
      bobStore.scopedStatus(acme, 'monthUsage', { month: new Date().toISOString().slice(0, 7) })?.isComplete === true,
  )
  expect(rowsOfChat()).toBe(0)
  await database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${chat}, ${bob}, 'reader')`
  await waitFor(() => rowsOfChat() === 4)
  expect(
    bobStore
      .read()
      .latestMessages.filter((row) => row.chatId === chat)
      .map((row) => row.id),
  ).toEqual([messageId(`${chat}-hello`)])
  await database.$client`delete from chat_participants where chat_id = ${chat} and user_id = ${bob}`
  await waitFor(() => rowsOfChat() === 0)
})
