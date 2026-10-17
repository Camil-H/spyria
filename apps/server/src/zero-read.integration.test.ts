import { expect, test } from 'bun:test'
import { conversationMutators } from '@hq/conversation/server'
import { createMockSnapshot, type Snapshot } from '@hq/db'
import { createZeroStore } from '@hq/db/zero-store'
import type { ChatId, MemberId, WorkspaceId } from '@hq/kernel'
import { workspaceMutators } from '@hq/workspace/server'
import {
  acme,
  alice,
  globex,
  lee,
  openSharedTestApp,
  openZeroStore,
  bob,
  waitFor,
  zeroSessionsOf,
} from './testing/testing.ts'

const { database } = await openSharedTestApp()

const collectionsInStoredOrder = ['messages', 'terminalLines', 'planSteps', 'workspaceConnections', 'toolConnections']

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
    projects: inWorkspaces(snapshot.projects),
    chats: readableChats,
    chatRoles: inWorkspaces(snapshot.chatRoles),
    messages: inReadableChats(snapshot.messages),
    files: inReadableChats(snapshot.files),
    changes: inReadableChats(snapshot.changes),
    terminalLines: inReadableChats(snapshot.terminalLines),
    planSteps: inReadableChats(snapshot.planSteps),
    commits: inReadableChats(snapshot.commits),
    browserPages: inReadableChats(snapshot.browserPages),
    usageEntries: inReadableChats(snapshot.usageEntries),
    sources: inReadableChats(snapshot.sources),
    chatMembers: inReadableChats(snapshot.chatMembers),
    readMarkers: inReadableChats(ownedByViewer(snapshot.readMarkers)),
    llmCredentials: ownedByViewer(snapshot.llmCredentials),
    workspaceConnections: ownedByViewerOrReadableChatOwner(snapshot.workspaceConnections),
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
const replicaWatcher = await openZeroStore(createZeroStore, alice, [acme, globex])
await waitFor(() => Bun.deepEquals(normalized(replicaWatcher.read()), expectedFor(alice, [acme, globex])))

test.each([
  { viewer: 'Alice', viewerId: alice, workspaceIds: [acme, globex] },
  { viewer: 'Bob', viewerId: bob, workspaceIds: [acme] },
  { viewer: 'Lee', viewerId: lee, workspaceIds: [acme] },
])('$viewer reads through Zero exactly the mock snapshot visible to them', async ({ viewerId, workspaceIds }) => {
  const store = await openZeroStore(createZeroStore, viewerId, workspaceIds)
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
    const read = store.read()
    expect(read.chats.map((chat) => chat.name)).toEqual([...chats])
    const readableChatIds = new Set<string>(read.chats.map((chat) => chat.id))
    const chatIdsOf = (rows: readonly { chatId: string }[]) => rows.map((row) => row.chatId)
    for (const rows of [read.messages, read.chatMembers, read.files, read.usageEntries, read.browserPages])
      expect(chatIdsOf(rows).filter((id) => !readableChatIds.has(id))).toEqual([])
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
  await expect(
    store.mutate(
      globex,
      workspaceMutators.workspace.createProject({ workspaceId: globex, id: 'project-signed-out', name: 'Signed out' }),
    ),
  ).rejects.toThrow('Workspace workspace-globex is not open')
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
  await expect(
    store.mutate(
      acme,
      conversationMutators.conversation.sendMessage({
        workspaceId: acme,
        id: 'message-reader-posts',
        chatId: 'chat-invoice-bug',
        text: 'Readers cannot post',
      }),
    ),
  ).rejects.toThrow('You need the chat.post permission on this chat')
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
  await expect(confirmation).rejects.toThrow('You need the chat.admin permission on this chat')
  await waitFor(() => onboardingOf()?.archived === false)
  expect(await database.query.projects.findFirst({ where: { id: 'project-onboarding' } })).toMatchObject({
    archived: false,
  })
})
