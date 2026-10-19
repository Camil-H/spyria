import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@spyria/kernel'
import { InvalidEmail } from './errors.ts'
import { displayNameFrom, Email, inviteLifetimeMilliseconds, isOpen, isPending, newInvitation } from './invitation.ts'

const now = Date.parse('2026-10-17T12:00:00Z')
const invitation = newInvitation(
  {
    workspaceId: workspaceId('acme'),
    id: 'invite-1',
    email: 'nina@example.com',
    role: 'member',
    invitedBy: memberId('alice'),
  },
  now,
)

test('an email is trimmed and lowercased, and anything without a domain is refused', () => {
  expect(Email('  Nina@Example.COM ')).toBe('nina@example.com')
  for (const text of ['nina', 'nina@', '@example.com', 'ni na@example.com', 'nina@example'])
    expect(() => Email(text)).toThrow(InvalidEmail)
})

test('an invite is pending for 7 days until revoked or accepted', () => {
  expect(invitation.expiresAt - invitation.createdAt).toBe(inviteLifetimeMilliseconds)
  expect(inviteLifetimeMilliseconds).toBe(7 * 24 * 60 * 60 * 1000)
  expect(isPending(invitation, now + inviteLifetimeMilliseconds - 1)).toBe(true)
  expect(isPending(invitation, now + inviteLifetimeMilliseconds)).toBe(false)
  expect(isOpen(invitation)).toBe(true)
  expect(isPending({ ...invitation, revokedAt: now }, now)).toBe(false)
  expect(isPending({ ...invitation, acceptedAt: now }, now)).toBe(false)
})

test('a display name comes from the name claim, else from the email’s local part', () => {
  expect(displayNameFrom({ name: ' Nina Simone ', email: 'nina@example.com' })).toBe('Nina Simone')
  expect(displayNameFrom({ name: '  ', email: 'Nina.S@Example.com' })).toBe('nina.s')
  expect(displayNameFrom({ name: 42, email: 'nina@example.com' })).toBe('nina')
})
