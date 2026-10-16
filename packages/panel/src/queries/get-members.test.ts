import { expect, test } from 'bun:test'
import { acme, createMockSnapshot } from '@hq/db'
import { chatId } from '@hq/kernel'
import { getMembers } from './get-members.ts'

test('members lists the owner first, alone when no explicit members', () => {
  const snapshot = createMockSnapshot()
  expect(getMembers(acme, chatId('chat-invoice-bug'))(snapshot).map((member) => [member.name, member.role])).toEqual([
    ['Alice', 'Owner'],
    ['Bob', 'Can prompt'],
  ])
  expect(getMembers(acme, chatId('chat-research'))(snapshot).map((member) => member.role)).toEqual(['Owner'])
})
