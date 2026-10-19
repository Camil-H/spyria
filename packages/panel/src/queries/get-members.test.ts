import { expect, test } from 'bun:test'
import { acme, alice, bob, createMockSnapshot, lee } from '@spyria/db'
import { type ChatId, type ChatPermission, chatId, chatPermissions, type MemberId } from '@spyria/kernel'
import { getMembers } from './get-members.ts'

const snapshot = createMockSnapshot()
const invoiceBug = chatId('chat-invoice-bug')
const research = chatId('chat-research')

test('members lists the owner first, then the participants with their role names', () => {
  expect(getMembers(acme, invoiceBug, alice)(snapshot)?.members.map((member) => [member.name, member.role])).toEqual([
    ['Alice', 'Owner'],
    ['Bob', 'Prompter'],
    ['Lee', 'Reader'],
  ])
  expect(getMembers(acme, research, alice)(snapshot)?.members.map((member) => member.role)).toEqual(['Owner'])
})

test('the controls follow the viewer’s permissions on the chat', () => {
  const withBobEditorOfResearch = {
    ...snapshot,
    chatMembers: [...snapshot.chatMembers, { workspaceId: acme, chatId: research, memberId: bob, roleId: 'editor' }],
  }
  const controlsOf = (members: ReturnType<ReturnType<typeof getMembers>>) =>
    members && {
      canManage: members.canManage,
      canLeave: members.canLeave,
      assignable: members.assignableRoles.map((role) => role.id),
      invitable: members.invitableRoles.map((role) => role.id),
      invitees: members.invitees.map((invitee) => invitee.name),
    }
  expect(controlsOf(getMembers(acme, invoiceBug, alice)(snapshot))).toEqual({
    canManage: true,
    canLeave: false,
    assignable: ['editor', 'prompter', 'reader'],
    invitable: ['editor', 'prompter', 'reader'],
    invitees: [],
  })
  expect(controlsOf(getMembers(acme, invoiceBug, lee)(snapshot))).toMatchObject({
    canManage: false,
    canLeave: true,
    invitable: [],
  })
  expect(controlsOf(getMembers(acme, research, bob)(withBobEditorOfResearch))).toMatchObject({
    canManage: false,
    canLeave: true,
    invitable: ['editor', 'prompter', 'reader'],
    invitees: ['Lee'],
  })
  expect(controlsOf(getMembers(acme, research, alice)(snapshot))?.invitees).toEqual(['Bob', 'Lee'])
})

test('a public channel offers no Reader role and no Remove, and offers them again once private', () => {
  const welcome = chatId('chat-welcome')
  const controlsOf = (members: ReturnType<ReturnType<typeof getMembers>>) =>
    members && {
      canManage: members.canManage,
      canRemove: members.canRemove,
      assignable: members.assignableRoles.map((role) => role.id),
      invitable: members.invitableRoles.map((role) => role.id),
    }
  expect(controlsOf(getMembers(acme, welcome, alice)(snapshot))).toEqual({
    canManage: true,
    canRemove: false,
    assignable: ['editor', 'prompter'],
    invitable: ['editor', 'prompter'],
  })
  const privateWelcome = {
    ...snapshot,
    chats: snapshot.chats.map((chat) => (chat.id === welcome ? { ...chat, visibility: 'private' as const } : chat)),
  }
  expect(controlsOf(getMembers(acme, welcome, alice)(privateWelcome))).toEqual({
    canManage: true,
    canRemove: true,
    assignable: ['editor', 'prompter', 'reader'],
    invitable: ['editor', 'prompter', 'reader'],
  })
})

test('custom roles are assignable within the actor’s own permissions, never as Owner, and only with chat.post on a public channel', () => {
  const customRole = (id: string, permissions: readonly ChatPermission[]) => ({
    workspaceId: acme,
    id,
    name: id,
    permissions,
    builtIn: false,
  })
  const withCustomRoles = {
    ...snapshot,
    chatRoles: [
      ...snapshot.chatRoles,
      customRole('reviewer', ['chat.read', 'session.configure']),
      customRole('poster', ['chat.read', 'chat.post', 'session.configure']),
      customRole('superuser', chatPermissions),
    ],
    chatMembers: [...snapshot.chatMembers, { workspaceId: acme, chatId: research, memberId: bob, roleId: 'editor' }],
  }
  const rolesOf = (chat: ChatId, viewerId: MemberId) => {
    const members = getMembers(acme, chat, viewerId)(withCustomRoles)
    return {
      assignable: members?.assignableRoles.map((role) => role.id),
      invitable: members?.invitableRoles.map((role) => role.id),
    }
  }
  expect(rolesOf(invoiceBug, alice)).toEqual({
    assignable: ['superuser', 'editor', 'poster', 'prompter', 'reviewer', 'reader'],
    invitable: ['superuser', 'editor', 'poster', 'prompter', 'reviewer', 'reader'],
  })
  expect(rolesOf(research, bob).invitable).toEqual(['editor', 'poster', 'prompter', 'reviewer', 'reader'])
  expect(rolesOf(chatId('chat-welcome'), alice)).toEqual({
    assignable: ['superuser', 'editor', 'poster', 'prompter'],
    invitable: ['superuser', 'editor', 'poster', 'prompter'],
  })
})
