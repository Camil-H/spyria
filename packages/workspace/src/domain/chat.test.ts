import { expect, test } from 'bun:test'
import { chatId, memberId, projectId } from '@hq/kernel'
import { archivedChat, type Chat, movedChat, startRuntimeChat, visibleChat } from './chat.ts'
import { CrossWorkspaceMove, RuntimeChatPrivate, SourceChatArchived } from './errors.ts'
import { Name } from './name.ts'
import { acme, chatInAcme, globex, projectIn } from './testing.ts'

test('movedChat rejects a project of another workspace', () => {
  expect(() => movedChat(chatInAcme, projectIn(globex))).toThrow(CrossWorkspaceMove)
})

test('movedChat sets and clears the project', () => {
  const otherProject = { ...projectIn(acme), id: projectId('other') }
  expect(movedChat(chatInAcme, otherProject).projectId).toBe(otherProject.id)
  expect(movedChat(chatInAcme, null).projectId).toBeNull()
})

const runtimeFields = {
  id: chatId('new'),
  name: Name('From message'),
  ownerId: memberId('bob'),
}

test('startRuntimeChat creates a runtime chat in the source workspace and project, linked to the source', () => {
  const channel: Chat = {
    ...chatInAcme,
    type: 'channel',
    visibility: 'public',
    model: null,
    reasoningEffort: null,
    gitBranch: null,
  }
  expect(startRuntimeChat(channel, runtimeFields)).toEqual({
    ...runtimeFields,
    model: null,
    reasoningEffort: null,
    workspaceId: acme,
    projectId: channel.projectId,
    type: 'runtime',
    visibility: 'private',
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

test('visibleChat changes a channel’s visibility and keeps a runtime chat private', () => {
  const channel: Chat = { ...chatInAcme, type: 'channel', visibility: 'public' }
  expect(visibleChat(channel, 'private').visibility).toBe('private')
  expect(visibleChat({ ...channel, visibility: 'private' }, 'public').visibility).toBe('public')
  expect(() => visibleChat(chatInAcme, 'public')).toThrow(RuntimeChatPrivate)
  expect(() => visibleChat(chatInAcme, 'private')).toThrow(RuntimeChatPrivate)
})
