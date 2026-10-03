import { expect, test } from 'bun:test'
import { createMockSnapshot } from '@hq/db'
import { chatId, workspaceId } from '@hq/kernel'
import { getMembers } from './get-members.ts'
import { getUsage } from './get-usage.ts'

const acme = workspaceId('workspace-acme')

test('usage sums per prompting member and totals', () => {
  const usage = getUsage(acme, chatId('chat-invoice-bug'))(createMockSnapshot())
  expect(usage.rows.map((row) => [row.name, row.tokens, row.costCents])).toEqual([
    ['Alice', 12400, 18],
    ['Bob', 3100, 5],
  ])
  expect(usage.total).toEqual({ tokens: 15500, costCents: 23 })
})

test('usage shows zeros for prompting members without entries', () => {
  const usage = getUsage(acme, chatId('chat-welcome'))(createMockSnapshot())
  expect(usage.rows.map((row) => [row.name, row.tokens])).toEqual([
    ['Alice', 0],
    ['Bob', 0],
  ])
  expect(usage.total).toEqual({ tokens: 0, costCents: 0 })
})

test('members lists the owner first, alone when no explicit members', () => {
  const snapshot = createMockSnapshot()
  expect(getMembers(acme, chatId('chat-invoice-bug'))(snapshot).map((member) => [member.name, member.role])).toEqual([
    ['Alice', 'Owner'],
    ['Bob', 'Can prompt'],
  ])
  expect(getMembers(acme, chatId('chat-research'))(snapshot).map((member) => member.role)).toEqual(['Owner'])
})
