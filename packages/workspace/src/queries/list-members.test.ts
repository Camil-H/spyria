import { expect, test } from 'bun:test'
import { acme, alice, createMockSnapshot, globex, lee, bob } from '@hq/db'
import { listInvitations, listMembers } from './list-members.ts'

const snapshot = createMockSnapshot()
const withLeeRemoved = {
  ...snapshot,
  memberships: snapshot.memberships.map((membership) =>
    membership.memberId === lee ? { ...membership, removedAt: '2026-10-17T00:00:00.000Z' } : membership,
  ),
}

test('lists the active members of a workspace by name', () => {
  expect(listMembers(acme)(withLeeRemoved)).toEqual([
    { id: alice, name: 'Alice', email: 'alice@example.com', role: 'admin' },
    { id: bob, name: 'Bob', email: 'bob@example.com', role: 'member' },
  ])
})

test('lists the open invitations of the workspace only', () => {
  const invitation = { id: 'invite-nina', email: 'nina@example.com', role: 'member' as const, expiresAt: 1 }
  const withInvitations = {
    ...snapshot,
    invitations: [
      { ...invitation, workspaceId: acme },
      { ...invitation, id: 'invite-globex', workspaceId: globex },
    ],
  }
  expect(listInvitations(acme)(withInvitations)).toEqual([{ ...invitation, workspaceId: acme }])
})
