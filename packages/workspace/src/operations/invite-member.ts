import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { AlreadyMember, InviteAlreadyPending } from '../domain/errors.ts'
import { Email, isPending, newInvitation } from '../domain/invitation.ts'
import { isActive, requireAdmin, type WorkspaceRole } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = {
  workspaceId: WorkspaceId
  id: string
  email: string
  role: WorkspaceRole
  actorId: MemberId
  now: number
}

export const inviteMember = ({ transactor }: Dependencies, { email: text, role, actorId, now, ...input }: Input) =>
  transactor.run(async ({ memberships, invitations, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId))
    const email = Email(text)
    if (isActive(await memberships.findByEmail(email))) throw new AlreadyMember(email)
    const open = await invitations.findOpen(email)
    if (open && isPending(open, now)) throw new InviteAlreadyPending(email)
    if (open) await invitations.save({ ...open, revokedAt: now })
    await invitations.add(newInvitation({ ...input, email, role, invitedBy: actorId }, now))
    await workspaceEvents.record({ type: 'member.invited', actorId, payload: { invitationId: input.id, email, role } })
  })
