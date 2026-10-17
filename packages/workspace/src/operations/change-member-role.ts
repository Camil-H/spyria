import type { MemberId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireActiveMember, requireAdmin, requireAnotherAdmin, type WorkspaceRole } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { memberId: MemberId; role: WorkspaceRole; actorId: MemberId }

export const changeMemberRole = ({ transactor }: Dependencies, { memberId, role, actorId }: Input) =>
  transactor.run(async ({ memberships, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId))
    const member = requireActiveMember(await memberships.get(memberId), memberId)
    if (member.role === role) return
    requireAnotherAdmin(member, await memberships.activeAdminIds())
    await memberships.save({ ...member, role })
    await workspaceEvents.record({ type: 'member.role_changed', actorId, payload: { memberId, role } })
  })
