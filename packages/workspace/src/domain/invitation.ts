import type { MemberId, WorkspaceId } from '@spyria/kernel'
import { InvalidEmail } from './errors.ts'

export type Invitation = Readonly<{
  workspaceId: WorkspaceId
  id: string
  email: string
  role: string
  invitedBy: MemberId
  createdAt: number
  expiresAt: number
  revokedAt: number | null
  acceptedAt: number | null
}>

export const inviteLifetimeMilliseconds = 7 * 24 * 60 * 60 * 1000
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const normalizedEmail = (text: string) => text.trim().toLowerCase()

export const Email = (text: string) => {
  const email = normalizedEmail(text)
  if (!emailPattern.test(email)) throw new InvalidEmail(text)
  return email
}

export const isOpen = (invitation: Invitation) => invitation.revokedAt === null && invitation.acceptedAt === null

export const isPending = (invitation: Invitation, now: number) => isOpen(invitation) && invitation.expiresAt > now

export const newInvitation = (
  fields: Pick<Invitation, 'workspaceId' | 'id' | 'email' | 'role' | 'invitedBy'>,
  now: number,
): Invitation => ({
  ...fields,
  createdAt: now,
  expiresAt: now + inviteLifetimeMilliseconds,
  revokedAt: null,
  acceptedAt: null,
})

export const displayNameFrom = ({ name, email }: { name?: unknown; email: string }) =>
  (typeof name === 'string' && name.trim()) || normalizedEmail(email).split('@')[0] || email
