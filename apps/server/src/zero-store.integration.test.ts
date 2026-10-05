import { afterAll, expect, test } from 'bun:test'
import { conversationMutators } from '@hq/conversation/server'
import { createMockSnapshot, type Snapshot } from '@hq/db'
import { createZeroStore } from '@hq/db/zero-store'
import { type MemberId, type WorkspaceId, workspaceId } from '@hq/kernel'
import { workspaceMutators } from '@hq/workspace/server'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'
import { acme, alice, globex, openSharedTestApp, bob, testAuthSettings, waitFor } from './testing.ts'

const { database, zeroCacheUrl } = await openSharedTestApp()
const openedStores: ReturnType<typeof createZeroStore>[] = []
afterAll(() => Promise.all(openedStores.map((store) => store.close())))

const sessionsOf = async (viewerId: MemberId, workspaceIds: readonly WorkspaceId[]) =>
  Promise.all(
    (await openSessions(database, viewerId))
      .filter((session) => workspaceIds.includes(workspaceId(session.workspaceId)))
      .map(async (session) => {
        const issued = await issueSessionToken(testAuthSettings.tokenSecret, session)
        return { ...issued, workspaceId: workspaceId(issued.workspaceId) }
      }),
  )

const openStore = async (viewerId: MemberId, workspaceIds: readonly WorkspaceId[]) => {
  const store = createZeroStore({
    memberId: viewerId,
    sessions: await sessionsOf(viewerId, workspaceIds),
    renew: async (workspace) => (await sessionsOf(viewerId, [workspace]))[0],
    cacheURL: zeroCacheUrl,
    kvStore: 'mem',
    mutators: { ...workspaceMutators, ...conversationMutators },
  })
  openedStores.push(store)
  await Promise.all(workspaceIds.map((workspace) => store.whenLoaded(workspace)))
  return store
}

const collectionsInStoredOrder = ['messages', 'terminalLines', 'planSteps', 'workspaceConnections', 'toolConnections']

const visibleTo = (snapshot: Snapshot, viewerId: MemberId, workspaceIds: readonly WorkspaceId[]): Snapshot => {
  const inWorkspaces = <Row extends { workspaceId: WorkspaceId }>(rows: readonly Row[]) =>
    rows.filter((row) => workspaceIds.includes(row.workspaceId))
  const ownedByViewer = <Row extends { workspaceId: WorkspaceId; memberId: MemberId }>(rows: readonly Row[]) =>
    inWorkspaces(rows).filter((row) => row.memberId === viewerId)
  const chatOwners = new Set(inWorkspaces(snapshot.chats).map((chat) => `${chat.workspaceId}/${chat.ownerId}`))
  const ownedByViewerOrChatOwner = <Row extends { workspaceId: WorkspaceId; memberId: MemberId }>(
    rows: readonly Row[],
  ) =>
    inWorkspaces(rows).filter(
      (row) => row.memberId === viewerId || chatOwners.has(`${row.workspaceId}/${row.memberId}`),
    )
  return {
    ...snapshot,
    workspaces: snapshot.workspaces.filter((workspace) => workspaceIds.includes(workspace.id)),
    memberships: inWorkspaces(snapshot.memberships),
    projects: inWorkspaces(snapshot.projects),
    chats: inWorkspaces(snapshot.chats),
    messages: inWorkspaces(snapshot.messages),
    files: inWorkspaces(snapshot.files),
    changes: inWorkspaces(snapshot.changes),
    terminalLines: inWorkspaces(snapshot.terminalLines),
    planSteps: inWorkspaces(snapshot.planSteps),
    commits: inWorkspaces(snapshot.commits),
    browserPages: inWorkspaces(snapshot.browserPages),
    usageEntries: inWorkspaces(snapshot.usageEntries),
    sources: inWorkspaces(snapshot.sources),
    chatMembers: inWorkspaces(snapshot.chatMembers),
    readMarkers: ownedByViewer(snapshot.readMarkers),
    llmCredentials: ownedByViewer(snapshot.llmCredentials),
    workspaceConnections: ownedByViewerOrChatOwner(snapshot.workspaceConnections),
    toolConnections: ownedByViewerOrChatOwner(snapshot.toolConnections),
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
const replicaWatcher = await openStore(alice, [acme, globex])
await waitFor(() => Bun.deepEquals(normalized(replicaWatcher.read()), expectedFor(alice, [acme, globex])))

test.each([
  { viewer: 'Alice', viewerId: alice, workspaceIds: [acme, globex] },
  { viewer: 'Bob', viewerId: bob, workspaceIds: [acme] },
])('$viewer reads through Zero exactly the mock snapshot visible to them', async ({ viewerId, workspaceIds }) => {
  const store = await openStore(viewerId, workspaceIds)
  expect(normalized(store.read())).toEqual(expectedFor(viewerId, workspaceIds))
})

test('signing out of a workspace removes its rows but keeps it listed, signing in brings them back', async () => {
  const store = await openStore(alice, [acme, globex])
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
  const [globexSession] = await sessionsOf(alice, [globex])
  if (!globexSession) throw new Error('Alice has no Globex session')
  await store.signIn(globexSession)
  expect(store.signedInWorkspaceIds()).toEqual(new Set([acme, globex]))
  expect(store.read().chats.filter((chat) => chat.workspaceId === globex).length).toBe(2)
})

test('a mutation through the store reaches the replica and, once the server confirms, Postgres', async () => {
  const store = await openStore(alice, [acme])
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
  const store = await openStore(alice, [acme])
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
