import { expect, test } from 'bun:test'
import { createMockSnapshot } from '@hq/db'
import { chatId, workspaceId } from '@hq/kernel'
import { getMembers } from './get-members.ts'

const acme = workspaceId('workspace-acme')

test('members lists the owner first, alone when no explicit members', () => {
  const snapshot = createMockSnapshot()
  expect(getMembers(acme, chatId('chat-invoice-bug'))(snapshot).map((member) => [member.name, member.role])).toEqual([
    ['Alice', 'Owner'],
    ['Bob', 'Can prompt'],
  ])
  expect(getMembers(acme, chatId('chat-research'))(snapshot).map((member) => member.role)).toEqual(['Owner'])
})
