import { expect, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { schema } from '@spyria/db/zero'
import { chatPermissionsOf } from '@spyria/db/zero-queries'
import { builtInChatRoles, chatId, memberId } from '@spyria/kernel'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  chatAccessRows,
  chatAs,
  failedWith,
  globex,
  lee,
  missingPermission,
  newChat,
  openSharedTestApp,
  succeeded,
  workspaceEventsOf,
} from './testing/testing.ts'

const { database, resultOf, chatRow, changesOf } = await openSharedTestApp()

const projectRow = (id: string) => database.query.projects.findFirst({ where: { id } })
const participantsOf = (chatId: string) =>
  database.$client`select user_id as "userId", role_id as "roleId" from chat_participants where chat_id = ${chatId}`.then(
    (rows) => [...rows],
  )

test('createProject inserts the project in the token workspace with a server creation time', async () => {
  const before = Date.now()
  expect(
    await resultOf(aliceInAcme, 'workspace.createProject', { workspaceId: acme, id: 'project-new', name: ' New ' }),
  ).toEqual(succeeded)
  const project = await projectRow('project-new')
  expect(project).toMatchObject({ workspaceId: acme, name: 'New', archived: false })
  expect(project?.createdAt.getTime()).toBeGreaterThanOrEqual(before)
})

test.each([
  { type: 'runtime', requested: 'by default', visibility: 'private', projectId: 'project-billing' },
  { type: 'channel', requested: 'by default', visibility: 'public', projectId: null },
  { type: 'channel', requested: 'on request', visibility: 'private', projectId: null },
  { type: 'runtime', requested: 'on request', visibility: 'public', projectId: null },
] as const)(
  'createChat makes a $type chat $visibility $requested, owned by the caller rather than a named owner',
  async ({ type, requested, visibility, projectId }) => {
    const id = `chat-${crypto.randomUUID()}`
    expect(
      await resultOf(bobInAcme, 'workspace.createChat', {
        workspaceId: acme,
        id,
        name: 'Agent',
        type,
        ...(requested === 'on request' ? { visibility } : {}),
        projectId,
        ownerId: alice,
      }),
    ).toEqual(succeeded)
    expect(await chatRow(id)).toMatchObject({
      workspaceId: acme,
      projectId,
      type,
      ownerKind: 'user',
      ownerUserId: bob,
      visibility,
      model: null,
      reasoningEffort: null,
      archived: false,
    })
    expect(await participantsOf(id)).toEqual([{ userId: bob, roleId: 'owner' }])
  },
)

test.each([
  ['the owner', 'chat-research', alice, builtInChatRoles[0]?.permissions],
  ['a prompter', 'chat-invoice-bug', bob, ['chat.read', 'chat.post']],
  ['a reader', 'chat-invoice-bug', lee, ['chat.read']],
  ['a non-participant of a private chat', 'chat-research', bob, []],
  ['a non-participant of a public channel', 'chat-standup', lee, ['chat.read', 'chat.post']],
  ['a member of a chat of another workspace', 'chat-general', bob, []],
])('the permissions read gives %s their effective permissions', async (_, chat, member, permissions) => {
  expect(
    await zeroDrizzle(schema, database).transaction((tx) =>
      chatPermissionsOf(tx, acme).permissions(chatId(chat), memberId(member)),
    ),
  ).toEqual(permissions as never)
})

test('renameProject renames the project', async () => {
  const projectId = `project-${crypto.randomUUID()}`
  expect(
    await resultOf(aliceInAcme, 'workspace.createProject', { workspaceId: acme, id: projectId, name: 'Onboarding' }),
  ).toEqual(succeeded)
  expect(
    await resultOf(aliceInAcme, 'workspace.renameProject', {
      workspaceId: acme,
      projectId,
      name: 'Starting',
    }),
  ).toEqual(succeeded)
  expect(await projectRow(projectId)).toMatchObject({ name: 'Starting' })
})

test('createWorkspace creates the workspace, the caller admin membership with their display name and the built-in chat roles, and no sign-in provider of its own', async () => {
  expect(
    await resultOf(bobInAcme, 'workspace.createWorkspace', { workspaceId: acme, id: 'workspace-new', name: 'Initech' }),
  ).toEqual(succeeded)
  expect(await database.query.workspaces.findFirst({ where: { workspaceId: 'workspace-new' } })).toMatchObject({
    workspaceId: 'workspace-new',
    name: 'Initech',
    createdBy: bob,
  })
  expect(await database.query.memberships.findMany({ where: { workspaceId: 'workspace-new' } })).toEqual([
    { workspaceId: 'workspace-new', userId: bob, role: 'admin', displayName: 'Bob', avatar: null, removedAt: null },
  ])
  expect(
    (await database.query.chatRoles.findMany({ where: { workspaceId: 'workspace-new' }, orderBy: { id: 'asc' } })).map(
      ({ id, name, permissions, builtIn }) => ({ id, name, permissions, builtIn }),
    ),
  ).toEqual(
    builtInChatRoles
      .toSorted((first, second) => first.id.localeCompare(second.id))
      .map((role) => ({ ...role, permissions: [...role.permissions], builtIn: true })),
  )
  expect(await database.$client`select 1 from workspace_sso where workspace_id = 'workspace-new'`).toHaveLength(0)
  expect(await workspaceEventsOf(database, 'workspace-new')).toEqual([])
})

test("createWorkspace is refused to a session opened through its workspace's own provider, creating nothing", async () => {
  await database.$client`
    insert into workspace_sso (workspace_id, preset, issuer, client_id, encrypted_client_secret, updated_at)
    values (${acme}, 'oidc', 'https://idp.example.com', 'spyria-acme', 'sealed-secret', now())`
  try {
    expect(
      await resultOf(bobInAcme, 'workspace.createWorkspace', {
        workspaceId: acme,
        id: 'workspace-sso',
        name: 'Initech',
      }),
    ).toEqual(
      failedWith("Your organization's sign-in opens only its workspace: sign in with your own account to do this"),
    )
    expect(await database.query.workspaces.findFirst({ where: { workspaceId: 'workspace-sso' } })).toBeUndefined()
  } finally {
    await database.$client`delete from workspace_sso where workspace_id = ${acme}`
  }
})

test.each([
  [
    'createChat in a project of another workspace',
    'workspace.createChat',
    { id: 'chat-x', name: 'X', type: 'channel', projectId: 'project-launch' },
    'Project project-launch was not found',
  ],
  [
    'moveChat to a project of another workspace',
    'workspace.moveChat',
    { chatId: 'chat-standup', projectId: 'project-launch' },
    'Project project-launch was not found',
  ],
  [
    'renameChat of another workspace',
    'workspace.renameChat',
    { chatId: 'chat-launch-plan', name: 'Taken' },
    'Chat chat-launch-plan was not found',
  ],
  [
    'archiveChat of another workspace',
    'workspace.archiveChat',
    { chatId: 'chat-launch-plan' },
    'Chat chat-launch-plan was not found',
  ],
  [
    'renameProject of another workspace',
    'workspace.renameProject',
    { projectId: 'project-launch', name: 'Taken' },
    'Project project-launch was not found',
  ],
  [
    'archiveProject of another workspace',
    'workspace.archiveProject',
    { projectId: 'project-launch', chatsPolicy: 'archive' },
    'Project project-launch was not found',
  ],
  [
    'createWorkspace over an existing workspace id',
    'workspace.createWorkspace',
    { id: globex, name: 'Hijack' },
    'The change targets a workspace other than the current one',
  ],
  [
    'arguments naming another workspace than the token',
    'workspace.createProject',
    { workspaceId: globex, id: 'project-foreign', name: 'Foreign' },
    'The change targets a workspace other than the current one',
  ],
])('refuses %s', async (_, name, args, message) => {
  const before = await Promise.all([
    database.query.projects.findMany({ orderBy: { id: 'asc' } }),
    database.query.chats.findMany({ orderBy: { id: 'asc' } }),
    database.query.memberships.findMany({ orderBy: { userId: 'asc' } }),
  ])
  expect(await resultOf(bobInAcme, name, { workspaceId: acme, ...args })).toEqual(failedWith(message))
  expect(
    await Promise.all([
      database.query.projects.findMany({ orderBy: { id: 'asc' } }),
      database.query.chats.findMany({ orderBy: { id: 'asc' } }),
      database.query.memberships.findMany({ orderBy: { userId: 'asc' } }),
    ]),
  ).toEqual(before)
})

test('refuses invalid arguments', async () => {
  expect(
    await resultOf(aliceInAcme, 'workspace.archiveProject', {
      workspaceId: acme,
      projectId: 'project-billing',
      chatsPolicy: 'delete',
    }),
  ).toMatchObject({ error: 'app' })
  expect(await projectRow('project-billing')).toMatchObject({ archived: false })
})

test.each(chatAccessRows(['owner']))(
  'renameChat, moveChat and archiveChat need chat.admin: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role)
    const expected = isAllowed ? succeeded : missingPermission('chat.admin')
    expect(
      await resultOf(member, 'workspace.renameChat', { workspaceId: acme, chatId: chat, name: 'Renamed' }),
    ).toEqual(expected)
    expect(
      await resultOf(member, 'workspace.moveChat', { workspaceId: acme, chatId: chat, projectId: 'project-billing' }),
    ).toEqual(expected)
    expect(await resultOf(member, 'workspace.archiveChat', { workspaceId: acme, chatId: chat })).toEqual(expected)
    expect(await chatRow(chat)).toMatchObject(
      isAllowed
        ? { name: 'Renamed', projectId: 'project-billing', archived: true }
        : { name: 'Runtime chat', projectId: null, archived: false },
    )
  },
)

test('archiving a project with its chats needs chat.admin on each of them, even those the member cannot read; releasing them needs none', async () => {
  const project = (id: string) =>
    resultOf(bobInAcme, 'workspace.createProject', { workspaceId: acme, id, name: 'Shared' })
  const inProject = async (projectId: string, ownerId: string) => {
    const chat = await newChat({ ownerId })
    await database.$client`update chats set project_id = ${projectId} where id = ${chat}`
    return chat
  }
  const archive = (projectId: string, chatsPolicy: string) =>
    resultOf(bobInAcme, 'workspace.archiveProject', { workspaceId: acme, projectId, chatsPolicy })
  await project('project-mixed')
  const bobsChat = await inProject('project-mixed', bob)
  const alicesChat = await inProject('project-mixed', alice)
  expect(await archive('project-mixed', 'archive')).toEqual(missingPermission('chat.admin'))
  expect(await projectRow('project-mixed')).toMatchObject({ archived: false })
  expect(await chatRow(bobsChat)).toMatchObject({ archived: false })
  expect(await chatRow(alicesChat)).toMatchObject({ archived: false })
  expect(await archive('project-mixed', 'release')).toEqual(succeeded)
  expect(await projectRow('project-mixed')).toMatchObject({ archived: true })
  expect(await chatRow(alicesChat)).toMatchObject({ projectId: null, archived: false })

  await project('project-own')
  const ownChat = await inProject('project-own', bob)
  expect(await archive('project-own', 'archive')).toEqual(succeeded)
  expect(await chatRow(ownChat)).toMatchObject({ archived: true })
})

test.each(chatAccessRows(['owner']))(
  'changeVisibility needs chat.admin on the channel and records the change: $name',
  async ({ member, isAllowed, ...role }) => {
    const chat = await chatAs(role, 'channel')
    const before = role.isPublic ? 'public' : 'private'
    const after = before === 'public' ? 'private' : 'public'
    expect(
      await resultOf(member, 'workspace.changeVisibility', { workspaceId: acme, chatId: chat, visibility: after }),
    ).toEqual(isAllowed ? succeeded : missingPermission('chat.admin'))
    expect(await chatRow(chat)).toMatchObject({ visibility: isAllowed ? after : before })
    expect(await changesOf(chat)).toEqual(
      isAllowed
        ? [{ seq: 1, type: 'chat.visibility_changed', actor: member.userId, payload: { visibility: after } }]
        : [],
    )
  },
)

test.each(['channel', 'runtime'] as const)(
  'making a %s public turns its Readers into Prompters, recorded as role changes by the member who changed it, and private again',
  async (type) => {
    const chat = await newChat({
      type,
      visibility: 'private',
      participants: [
        { memberId: bob, roleId: 'reader' },
        { memberId: lee, roleId: 'prompter' },
      ],
    })
    expect(
      await resultOf(aliceInAcme, 'workspace.changeVisibility', {
        workspaceId: acme,
        chatId: chat,
        visibility: 'public',
      }),
    ).toEqual(succeeded)
    expect(await chatRow(chat)).toMatchObject({ type, visibility: 'public' })
    expect(await participantsOf(chat)).toEqual(
      expect.arrayContaining([
        { userId: alice, roleId: 'owner' },
        { userId: bob, roleId: 'prompter' },
        { userId: lee, roleId: 'prompter' },
      ]),
    )
    expect(await changesOf(chat)).toEqual([
      { seq: 1, type: 'chat.visibility_changed', actor: alice, payload: { visibility: 'public' } },
      { seq: 2, type: 'member.role_changed', actor: alice, payload: { memberId: bob, roleId: 'prompter' } },
    ])
    expect(
      await resultOf(aliceInAcme, 'workspace.changeVisibility', {
        workspaceId: acme,
        chatId: chat,
        visibility: 'private',
      }),
    ).toEqual(succeeded)
    expect(await chatRow(chat)).toMatchObject({ visibility: 'private' })
    expect((await changesOf(chat)).map((change) => change.type)).toEqual([
      'chat.visibility_changed',
      'member.role_changed',
      'chat.visibility_changed',
    ])
  },
)

const sidebarPositionsOf = (chatIds: string[]) =>
  database.$client`select chat_id as "chatId", user_id as "userId", sidebar_position as "sidebarPosition" from chat_participants where chat_id in ${database.$client(chatIds)} order by user_id, chat_id`.then(
    (rows) => [...rows],
  )

test("reorderChats sets the caller's own sidebar order and leaves the other participants' order alone", async () => {
  const sharedWithAlice = [{ memberId: alice, roleId: 'reader' }]
  const first = await newChat({ id: 'chat-sidebar-a', ownerId: bob, participants: sharedWithAlice })
  const second = await newChat({ id: 'chat-sidebar-b', ownerId: bob, participants: sharedWithAlice })
  expect(await resultOf(bobInAcme, 'workspace.reorderChats', { workspaceId: acme, chatIds: [second, first] })).toEqual(
    succeeded,
  )
  expect(await sidebarPositionsOf([first, second])).toEqual([
    { chatId: first, userId: alice, sidebarPosition: null },
    { chatId: second, userId: alice, sidebarPosition: null },
    { chatId: first, userId: bob, sidebarPosition: 1 },
    { chatId: second, userId: bob, sidebarPosition: 0 },
  ])
})

test('reorderChats naming a chat the caller is not a participant of is refused and places nothing', async () => {
  const bobsChat = await newChat({ id: 'chat-sidebar-own', ownerId: bob })
  const alicesChat = await newChat({ id: 'chat-sidebar-foreign', ownerId: alice })
  expect(
    await resultOf(bobInAcme, 'workspace.reorderChats', { workspaceId: acme, chatIds: [bobsChat, alicesChat] }),
  ).toEqual(failedWith(`Chat ${alicesChat} was not found`))
  expect(await sidebarPositionsOf([bobsChat, alicesChat])).toEqual([
    { chatId: alicesChat, userId: alice, sidebarPosition: null },
    { chatId: bobsChat, userId: bob, sidebarPosition: null },
  ])
})
