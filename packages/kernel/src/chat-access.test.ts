import { expect, test } from 'bun:test'
import {
  builtInChatRoles,
  type ChatPermission,
  can,
  MissingChatPermission,
  permissionsOf,
  requireChatPermission,
  visibilityOf,
} from './chat-access.ts'
import { chatId, memberId } from './ids.ts'

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

test('requireChatPermission passes a member holding the permission and names the missing one otherwise', async () => {
  const chats = { permissions: async () => ['chat.read' as const] }
  const [chat, member] = [chatId('chat-1'), memberId('member-1')]
  await requireChatPermission(chats, chat, member, 'chat.read')
  await expect(requireChatPermission(chats, chat, member, 'chat.post')).rejects.toBeInstanceOf(MissingChatPermission)
  await expect(requireChatPermission(chats, chat, member, 'chat.post')).rejects.toMatchObject({
    code: 'missing_chat_permission',
    message: 'You need the chat.post permission on this chat',
  })
})
