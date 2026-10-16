import { expect, test } from 'bun:test'
import { schema } from '@hq/db/zero'
import { memberChatPermissions } from '@hq/db/zero-queries'
import { builtInChatRoles, chatId, memberId } from '@hq/kernel'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import {
  acme,
  alice,
  aliceInAcme,
  failedWith,
  globex,
  lee,
  openSharedTestApp,
  bob,
  bobInAcme,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, chatRow } = await openSharedTestApp()

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

test('createChat inserts a runtime chat owned by the caller in the given project', async () => {
  expect(
    await resultOf(bobInAcme, 'workspace.createChat', {
      workspaceId: acme,
      id: 'chat-new',
      name: 'Agent',
      type: 'runtime',
      projectId: 'project-billing',
      ownerId: alice,
    }),
  ).toEqual(succeeded)
  expect(await chatRow('chat-new')).toMatchObject({
    workspaceId: acme,
    projectId: 'project-billing',
    type: 'runtime',
    ownerKind: 'user',
    ownerUserId: bob,
    visibility: 'private',
    model: null,
    reasoningEffort: null,
    archived: false,
  })
  expect(await participantsOf('chat-new')).toEqual([{ userId: bob, roleId: 'owner' }])
})

test('createChat makes a channel public with its creator as Owner', async () => {
  expect(
    await resultOf(bobInAcme, 'workspace.createChat', {
      workspaceId: acme,
      id: 'chat-new-channel',
      name: 'Lounge',
      type: 'channel',
      projectId: null,
    }),
  ).toEqual(succeeded)
  expect(await chatRow('chat-new-channel')).toMatchObject({ type: 'channel', visibility: 'public' })
  expect(await participantsOf('chat-new-channel')).toEqual([{ userId: bob, roleId: 'owner' }])
})

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
      memberChatPermissions(tx, acme, chatId(chat), memberId(member)),
    ),
  ).toEqual(permissions as never)
})

test('renameProject and archiveProject with the release policy update the project and detach its chats', async () => {
  expect(
    await resultOf(aliceInAcme, 'workspace.renameProject', {
      workspaceId: acme,
      projectId: 'project-onboarding',
      name: 'Starting',
    }),
  ).toEqual(succeeded)
  expect(
    await resultOf(aliceInAcme, 'workspace.archiveProject', {
      workspaceId: acme,
      projectId: 'project-onboarding',
      chatsPolicy: 'release',
    }),
  ).toEqual(succeeded)
  expect(await projectRow('project-onboarding')).toMatchObject({ name: 'Starting', archived: true })
  expect(await chatRow('chat-welcome')).toMatchObject({ projectId: null, archived: false })
})

test('createWorkspace creates the workspace, the caller admin membership with their display name and the built-in chat roles', async () => {
  expect(
    await resultOf(bobInAcme, 'workspace.createWorkspace', { workspaceId: acme, id: 'workspace-new', name: 'Initech' }),
  ).toEqual(succeeded)
  expect(await database.query.workspaces.findFirst({ where: { workspaceId: 'workspace-new' } })).toMatchObject({
    workspaceId: 'workspace-new',
    name: 'Initech',
    createdBy: bob,
  })
  expect(await database.query.memberships.findMany({ where: { workspaceId: 'workspace-new' } })).toEqual([
    { workspaceId: 'workspace-new', userId: bob, role: 'admin', displayName: 'Bob' },
  ])
  expect(
    (await database.query.chatRoles.findMany({ where: { workspaceId: 'workspace-new' } })).map(
      ({ id, name, permissions, builtIn }) => ({ id, name, permissions, builtIn }),
    ),
  ).toEqual(builtInChatRoles.map((role) => ({ ...role, permissions: [...role.permissions], builtIn: true })))
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
    { chatId: 'chat-research', projectId: 'project-launch' },
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
