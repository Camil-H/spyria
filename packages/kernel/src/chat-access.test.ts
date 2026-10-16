import { expect, test } from 'bun:test'
import { builtInChatRoles, type ChatPermission, can, permissionsOf, visibilityOf } from './chat-access.ts'

const roleNamed = (id: string) => builtInChatRoles.find((role) => role.id === id)
const permissionsOfRole = (id: string) => roleNamed(id)?.permissions

test('the built-in roles grant their permission sets and every role reads', () => {
  expect(permissionsOfRole('owner')).toEqual([
    'chat.read',
    'chat.post',
    'session.configure',
    'tools.manage',
    'members.invite',
    'members.manage',
    'chat.admin',
  ])
  expect(permissionsOfRole('editor')).toEqual(['chat.read', 'chat.post', 'session.configure', 'members.invite'])
  expect(permissionsOfRole('prompter')).toEqual(['chat.read', 'chat.post'])
  expect(permissionsOfRole('reader')).toEqual(['chat.read'])
  expect(builtInChatRoles.map((role) => role.name)).toEqual(['Owner', 'Editor', 'Prompter', 'Reader'])
})

test('a participant gets the permissions of their role, whatever the visibility', () => {
  const reader = roleNamed('reader')
  expect(permissionsOf({ visibility: 'public' }, reader)).toEqual(['chat.read'])
  expect(permissionsOf({ visibility: 'private' }, roleNamed('owner'))).toContain('chat.admin')
})

test('a non-participant reads and posts in a public channel and gets nothing in a private chat', () => {
  expect(permissionsOf({ visibility: 'public' }, undefined)).toEqual(['chat.read', 'chat.post'])
  expect(permissionsOf({ visibility: 'private' }, undefined)).toEqual([])
})

test('can checks one permission of a set', () => {
  const prompter = roleNamed('prompter')?.permissions ?? []
  expect(
    (['chat.read', 'chat.post', 'session.configure'] as ChatPermission[]).map((permission) =>
      can(prompter, permission),
    ),
  ).toEqual([true, true, false])
})

test('channels are public and runtime chats private', () => {
  expect([visibilityOf('channel'), visibilityOf('runtime')]).toEqual(['public', 'private'])
})
