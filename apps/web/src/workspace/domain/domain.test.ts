import { expect, test } from 'bun:test'
import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import { type Chat, moveChat } from './chat.ts'
import { BlankName, CrossWorkspaceMove } from './errors.ts'
import { Name } from './name.ts'
import { archiveProject, type Project } from './project.ts'

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
}

test('Name trims its value', () => {
  expect(String(Name('  Billing  '))).toBe('Billing')
})

test('Name rejects blank values', () => {
  expect(() => Name('   ')).toThrow(BlankName)
})

test('moveChat rejects a project of another workspace', () => {
  expect(() => moveChat(chatInAcme, projectIn(globex))).toThrow(CrossWorkspaceMove)
})

test('moveChat sets and clears the project', () => {
  const otherProject = { ...projectIn(acme), id: projectId('other') }
  expect(moveChat(chatInAcme, otherProject).projectId).toBe(otherProject.id)
  expect(moveChat(chatInAcme, null).projectId).toBeNull()
})

test('archiveProject with the archive policy archives the chats', () => {
  const result = archiveProject(projectIn(acme), [chatInAcme], 'archive')
  expect(result.project.archived).toBe(true)
  expect(result.chats[0]).toMatchObject({ archived: true, projectId: chatInAcme.projectId })
})

test('archiveProject with the release policy detaches the chats', () => {
  const result = archiveProject(projectIn(acme), [chatInAcme], 'release')
  expect(result.project.archived).toBe(true)
  expect(result.chats[0]).toMatchObject({ archived: false, projectId: null })
})
