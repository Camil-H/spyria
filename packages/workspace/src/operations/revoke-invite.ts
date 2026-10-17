import type { MemberId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { InviteNotFound } from '../domain/errors.ts'
import { isOpen } from '../domain/invitation.ts'
import { requireAdmin } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { invitationId: string; actorId: MemberId; now: number }

export const revokeInvite = ({ transactor }: Dependencies, { invitationId, actorId, now }: Input) =>
  transactor.run(async ({ memberships, invitations, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId))
    const invitation = await invitations.get(invitationId)
    if (!invitation || !isOpen(invitation)) throw new InviteNotFound(invitationId)
    await invitations.save({ ...invitation, revokedAt: now })
    await workspaceEvents.record({
      type: 'invite.revoked',
      actorId,
      payload: { invitationId, email: invitation.email },
    })
  })
