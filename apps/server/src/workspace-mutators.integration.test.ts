import { expect, test } from 'bun:test'
import {
  acme,
  alice,
  aliceInAcme,
  failedWith,
  globex,
  openSharedTestApp,
  bob,
  bobInAcme,
  succeeded,
} from './testing/testing.ts'

const { database, resultOf, chatRow } = await openSharedTestApp()

const projectRow = (id: string) => database.query.projects.findFirst({ where: { id } })

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
    model: null,
    reasoningEffort: null,
    archived: false,
  })
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

test('createWorkspace creates the workspace and the caller admin membership with their display name', async () => {
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
