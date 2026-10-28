import { expect, test } from 'bun:test'
import { acme, alice, bob } from '@spyria/db'
import { chatId } from '@spyria/kernel'
import { getChatUsage, isLocalSession } from './get-chat-usage.ts'
import { earlier, month, snapshot } from './testing.ts'

test('chat usage lists the owner and participants who can post, with zeros, plus any other prompter of the month', () => {
  expect(getChatUsage(acme, chatId('chat-welcome'), month)(snapshot).rows).toEqual([
    { memberId: alice, name: 'Alice', tokens: 10, costMicros: 0, calls: 1 },
    { memberId: bob, name: 'Bob', tokens: 0, costMicros: 0, calls: 0 },
  ])
  expect(getChatUsage(acme, chatId('chat-research'), month)(snapshot)).toEqual({
    months: [month],
    rows: [
      { memberId: alice, name: 'Alice', tokens: 0, costMicros: 0, calls: 0 },
      { memberId: bob, name: 'Bob', tokens: 50, costMicros: 1_000, calls: 1 },
    ],
    total: { tokens: 50, costMicros: 1_000, calls: 1 },
  })
})

test('chat usage counts only the picked month and lists the months with usage newest first', () => {
  const invoiceBug = chatId('chat-invoice-bug')
  expect(getChatUsage(acme, invoiceBug, month)(snapshot)).toMatchObject({
    months: [month, earlier],
    total: { tokens: 1300, costMicros: 25_000, calls: 3 },
  })
  expect(getChatUsage(acme, invoiceBug, earlier)(snapshot).total).toEqual({ tokens: 7, costMicros: 70, calls: 7 })
  expect(getChatUsage(acme, invoiceBug, '2026-01')(snapshot).total).toEqual({ tokens: 0, costMicros: 0, calls: 0 })
})

test('chat usage uses the workspace display name and ignores other workspaces', () => {
  const renamed = {
    ...snapshot,
    memberships: snapshot.memberships.map((membership) =>
      membership.memberId === alice && membership.workspaceId === acme
        ? { ...membership, displayName: 'Alice Martin' }
        : membership,
    ),
  }
  expect(getChatUsage(acme, chatId('chat-welcome'), month)(renamed).rows[0]?.name).toBe('Alice Martin')
  expect(getChatUsage(acme, chatId('chat-launch-plan'), month)(snapshot)).toEqual({
    months: [],
    rows: [],
    total: { tokens: 0, costMicros: 0, calls: 0 },
  })
})

test('an archived chat no longer counts as a session on a member’s machine', () => {
  const welcome = chatId('chat-welcome')
  const withLocalSession = (archived: boolean) => ({
    ...snapshot,
    chats: snapshot.chats.map((chat) => (chat.id === welcome ? { ...chat, localSession: true, archived } : chat)),
  })
  expect(isLocalSession(acme, welcome)(withLocalSession(false))).toBe(true)
  expect(isLocalSession(acme, welcome)(withLocalSession(true))).toBe(false)
})
