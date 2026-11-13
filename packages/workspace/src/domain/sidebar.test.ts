import { expect, test } from 'bun:test'
import { chatId } from '@spyria/kernel'
import { type SidebarPlacement, sidebarOrderWith } from './sidebar.ts'

const first = chatId('first')
const second = chatId('second')
const third = chatId('third')
const outside = chatId('outside')
const group = [first, second, third]

test.each([
  ['moves a chat up before its target', third, first, 'before', [third, first, second]],
  ['moves a chat down after its target', first, third, 'after', [second, third, first]],
  ['moves a chat down before its target', first, third, 'before', [second, first, third]],
  ['moves a chat up after its target', third, first, 'after', [first, third, second]],
  ['keeps the order when a chat is dropped on itself', second, second, 'before', group],
  ['inserts a chat from another group at the target', outside, second, 'after', [first, second, outside, third]],
  ['appends a chat when the target is not in the group', first, outside, 'before', [second, third, first]],
] as const)('sidebarOrderWith %s', (_, placedChatId, targetChatId, placement: SidebarPlacement, expected) => {
  expect(sidebarOrderWith(group, placedChatId, targetChatId, placement)).toEqual([...expected])
})
