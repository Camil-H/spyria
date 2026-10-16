import { expect, test } from 'bun:test'
import { chatId } from '@hq/kernel'
import { archivedChat, movedChat } from './chat.ts'
import { archivedProject } from './project.ts'
import { acme, chatInAcme, projectIn } from './testing.ts'

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

test('archivedProject leaves already archived chats alone under both policies', () => {
  const archived = archivedChat({ ...chatInAcme, id: chatId('archived') })
  expect(archivedProject(projectIn(acme), [chatInAcme, archived], 'archive').chats).toEqual([archivedChat(chatInAcme)])
  expect(archivedProject(projectIn(acme), [chatInAcme, archived], 'release').chats).toEqual([
    movedChat(chatInAcme, null),
  ])
})
