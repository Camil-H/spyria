import { expect, test } from 'bun:test'
import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import { archivedChat, type Chat, movedChat, startRuntimeChat } from './chat.ts'
import { BlankName, CrossWorkspaceMove, SourceChatArchived } from './errors.ts'
import { Name } from './name.ts'
import { archivedProject, type Project } from './project.ts'

const acme = workspaceId('acme')
const globex = workspaceId('globex')

const projectIn = (workspace: typeof acme): Project => ({
  id: projectId(`project-${workspace}`),
  workspaceId: workspace,
  name: Name('Billing'),
  archived: false,
})

const chatInAcme: Chat = {
  id: chatId('chat'),
  workspaceId: acme,
  projectId: projectId('project-acme'),
  type: 'runtime',
  name: Name('Invoice bug'),
  ownerId: memberId('alice'),
  archived: false,
  model: 'openai/gpt-5',
  reasoningEffort: 'medium',
  defaultModel: 'openai/gpt-5',
  gitBranch: 'main',
  originChatId: null,
}

const nameOrErrorOf = (text: string) => {
  try {
    return String(Name(text))
  } catch (error) {
    return error
  }
}

test.each([
  ['  Billing  ', 'Billing'],
  ['   ', expect.any(BlankName)],
])('Name(%p) is trimmed or rejected as blank', (text, expected) => {
  expect(nameOrErrorOf(text)).toEqual(expected)
})

test('movedChat rejects a project of another workspace', () => {
  expect(() => movedChat(chatInAcme, projectIn(globex))).toThrow(CrossWorkspaceMove)
})

test('movedChat sets and clears the project', () => {
  const otherProject = { ...projectIn(acme), id: projectId('other') }
  expect(movedChat(chatInAcme, otherProject).projectId).toBe(otherProject.id)
  expect(movedChat(chatInAcme, null).projectId).toBeNull()
})

test('archivedProject with the archive policy archives the chats', () => {
  const result = archivedProject(projectIn(acme), [chatInAcme], 'archive')
  expect(result.project.archived).toBe(true)
  expect(result.chats[0]).toMatchObject({ archived: true, projectId: chatInAcme.projectId })
})

test('archivedProject with the release policy detaches the chats', () => {
  const result = archivedProject(projectIn(acme), [chatInAcme], 'release')
  expect(result.project.archived).toBe(true)
  expect(result.chats[0]).toMatchObject({ archived: false, projectId: null })
})

const runtimeFields = {
  id: chatId('new'),
  name: Name('From message'),
  ownerId: memberId('bob'),
  defaultModel: 'fake/fake-medium',
}

test('startRuntimeChat creates a runtime chat in the source workspace and project, linked to the source', () => {
  const channel: Chat = {
    ...chatInAcme,
    type: 'channel',
    model: null,
    reasoningEffort: null,
    defaultModel: null,
    gitBranch: null,
  }
  expect(startRuntimeChat(channel, runtimeFields)).toEqual({
    ...runtimeFields,
    model: null,
    reasoningEffort: null,
    workspaceId: acme,
    projectId: channel.projectId,
    type: 'runtime',
    gitBranch: null,
    originChatId: channel.id,
    archived: false,
  })
})

test('startRuntimeChat keeps a loose source loose', () => {
  expect(startRuntimeChat({ ...chatInAcme, projectId: null }, runtimeFields).projectId).toBeNull()
})

test('startRuntimeChat rejects an archived source', () => {
  expect(() => startRuntimeChat(archivedChat(chatInAcme), runtimeFields)).toThrow(SourceChatArchived)
})

test('archivedProject leaves already archived chats alone under both policies', () => {
  const archived = archivedChat({ ...chatInAcme, id: chatId('archived') })
  expect(archivedProject(projectIn(acme), [chatInAcme, archived], 'archive').chats).toEqual([archivedChat(chatInAcme)])
  expect(archivedProject(projectIn(acme), [chatInAcme, archived], 'release').chats).toEqual([
    movedChat(chatInAcme, null),
  ])
})
