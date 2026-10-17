import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, lee, bob } from '@hq/db'
import { chatId } from '@hq/kernel'
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
