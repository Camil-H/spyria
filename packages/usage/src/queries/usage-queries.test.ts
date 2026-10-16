import { expect, test } from 'bun:test'
import { createMockSnapshot, type Snapshot } from '@hq/db'
import { chatId, memberId, projectId, workspaceId } from '@hq/kernel'
import { getChatUsage } from './get-chat-usage.ts'
import { getWorkspaceUsage } from './get-workspace-usage.ts'

const acme = workspaceId('workspace-acme')
const globex = workspaceId('workspace-globex')
const alice = memberId('member-alice')
const bob = memberId('member-bob')
const month = '2026-10'
const earlier = '2026-08'
const entry = (chat: string, member: typeof alice, tokens: number, costMicros: number, calls: number, at = month) => ({
  workspaceId: acme,
  month: at,
  chatId: chatId(chat),
  memberId: member,
  tokens,
  costMicros,
  calls,
})
const snapshot: Snapshot = {
  ...createMockSnapshot(),
  usageEntries: [
    entry('chat-invoice-bug', alice, 1000, 20_000, 2),
    entry('chat-invoice-bug', bob, 300, 5_000, 1),
    entry('chat-research', bob, 50, 1_000, 1),
    entry('chat-welcome', alice, 10, 0, 1),
    entry('chat-invoice-bug', alice, 7, 70, 7, earlier),
    { ...entry('chat-launch-plan', alice, 999, 999, 9), workspaceId: globex },
  ],
}

test('chat usage lists the owner and members who can prompt, with zeros, plus any other prompter of the month', () => {
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

test('workspace usage totals the month per member and per project, loose chats under "No project" last', () => {
  expect(getWorkspaceUsage(acme, month)(snapshot)).toEqual({
    months: [month, earlier],
    total: { tokens: 1360, costMicros: 26_000, calls: 5 },
    byMember: [
      { memberId: alice, name: 'Alice', tokens: 1010, costMicros: 20_000, calls: 3 },
      { memberId: bob, name: 'Bob', tokens: 350, costMicros: 6_000, calls: 2 },
    ],
    byProject: [
      { projectId: projectId('project-billing'), name: 'Billing', tokens: 1300, costMicros: 25_000, calls: 3 },
      { projectId: projectId('project-onboarding'), name: 'Onboarding', tokens: 10, costMicros: 0, calls: 1 },
      { projectId: null, name: 'No project', tokens: 50, costMicros: 1_000, calls: 1 },
    ],
  })
  expect(getWorkspaceUsage(acme, earlier)(snapshot)).toMatchObject({
    total: { tokens: 7, costMicros: 70, calls: 7 },
    byProject: [{ name: 'Billing', calls: 7 }],
  })
  expect(getWorkspaceUsage(globex, earlier)(snapshot)).toEqual({
    months: [month],
    total: { tokens: 0, costMicros: 0, calls: 0 },
    byMember: [],
    byProject: [],
  })
})
