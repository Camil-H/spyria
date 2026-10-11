import { expect, test } from 'bun:test'
import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import { archivedChat, type Chat, movedChat, renamedChat, sessionFieldsOf, startRuntimeChat } from './chat.ts'
import { BlankName, CrossWorkspaceMove, SourceChatArchived } from './errors.ts'
import { Name } from './name.ts'
import { archivedProject, type Project, renamedProject } from './project.ts'

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

test('Name trims its value', () => {
  expect(String(Name('  Billing  '))).toBe('Billing')
})

test('Name rejects blank values', () => {
  expect(() => Name('   ')).toThrow(BlankName)
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

test('archivedChat marks the chat archived and keeps the rest', () => {
  expect(archivedChat(chatInAcme)).toEqual({ ...chatInAcme, archived: true })
})

test('renamedChat sets the name and keeps the rest', () => {
  expect(renamedChat(chatInAcme, Name('  Invoice total bug '))).toEqual({
    ...chatInAcme,
    name: Name('Invoice total bug'),
  })
})

test('renamedProject sets the name and keeps the rest', () => {
  expect(renamedProject(projectIn(acme), Name(' Invoicing '))).toEqual({ ...projectIn(acme), name: Name('Invoicing') })
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

test('an On my machine chat is a runtime chat locked on Claude Code; other kinds have no harness', () => {
  expect(sessionFieldsOf('local_session')).toEqual({ type: 'runtime', harness: 'claude-code', localSession: true })
  expect(sessionFieldsOf('runtime')).toEqual({ type: 'runtime', harness: null, localSession: false })
  expect(sessionFieldsOf('channel')).toEqual({ type: 'channel', harness: null, localSession: false })
})
