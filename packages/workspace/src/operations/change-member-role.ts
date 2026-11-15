import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireActiveMember, requireAnotherAdmin, requireAnotherMember } from '../domain/member.ts'
import { requireGrantableRole } from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { memberId: MemberId; role: string; actorId: MemberId }

export const changeMemberRole = ({ transactor }: Dependencies, { memberId, role, actorId }: Input) =>
  transactor.run(async ({ memberships, workspaceRoles, memberAccess, workspaceEvents }) => {
    const actorPermissions = await requireWorkspacePermission(memberships, actorId, 'members.manage')
    requireAnotherMember(memberId, actorId)
    const member = requireActiveMember(await memberships.lock(memberId), memberId)
    requireGrantableRole(actorPermissions, await workspaceRoles.get(member.role), member.role)
    if (member.role === role) return
    requireGrantableRole(actorPermissions, await workspaceRoles.lock(role), role)
    requireAnotherAdmin(member, await memberships.activeAdminIds())
    await memberships.save({ ...member, role })
    await memberAccess.regrantToolsLater(memberId)
    await workspaceEvents.record({ type: 'member.role_changed', actorId, payload: { memberId, role } })
  })
