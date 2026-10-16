import { expect, test } from 'bun:test'
import { acme, createMockSnapshot } from '@hq/db'
import { chatId } from '@hq/kernel'
import { getMembers } from './get-members.ts'

test('members lists the owner first, then the participants with their role names', () => {
  const snapshot = createMockSnapshot()
  expect(getMembers(acme, chatId('chat-invoice-bug'))(snapshot).map((member) => [member.name, member.role])).toEqual([
    ['Alice', 'Owner'],
    ['Bob', 'Prompter'],
    ['Lee', 'Reader'],
  ])
  expect(getMembers(acme, chatId('chat-research'))(snapshot).map((member) => member.role)).toEqual(['Owner'])
})
