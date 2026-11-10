import { expect, test } from 'bun:test'
import { acme, alice, bob } from '@spyria/db'
import { chatId } from '@spyria/kernel'
import { getChatUsage, isLocalSession } from './get-chat-usage.ts'
import { haiku, snapshot, sonnet } from './testing.ts'

test('chat usage lists the owner and participants who can post, with zeros, plus any other prompter', () => {
  expect(getChatUsage(acme, chatId('chat-welcome'))(snapshot).rows).toEqual([
    { memberId: alice, name: 'Alice', tokens: 10, costMicros: 0, calls: 1 },
    { memberId: bob, name: 'Bob', tokens: 0, costMicros: 0, calls: 0 },
  ])
  expect(getChatUsage(acme, chatId('chat-research'))(snapshot)).toEqual({
    rows: [
      { memberId: alice, name: 'Alice', tokens: 0, costMicros: 0, calls: 0 },
      { memberId: bob, name: 'Bob', tokens: 50, costMicros: 1_000, calls: 1 },
    ],
    models: [{ model: sonnet, name: 'Sonnet 5.5', tokens: 50, costMicros: 1_000, calls: 1 }],
    total: { tokens: 50, costMicros: 1_000, calls: 1 },
  })
})

test('chat usage adds up every month of the chat, per member and per model, the costliest model first', () => {
  const invoiceBug = chatId('chat-invoice-bug')
  expect(getChatUsage(acme, invoiceBug)(snapshot).total).toEqual({ tokens: 1307, costMicros: 25_070, calls: 10 })
  expect(getChatUsage(acme, invoiceBug)(snapshot).models).toEqual([
    { model: sonnet, name: 'Sonnet 5.5', tokens: 1107, costMicros: 23_070, calls: 9 },
    { model: haiku, name: 'Haiku 5.5', tokens: 200, costMicros: 2_000, calls: 1 },
  ])
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
  expect(getChatUsage(acme, chatId('chat-welcome'))(renamed).rows[0]?.name).toBe('Alice Martin')
  expect(getChatUsage(acme, chatId('chat-launch-plan'))(snapshot)).toEqual({
    rows: [],
    models: [],
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
