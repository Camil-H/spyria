import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireActiveMember } from '../domain/member.ts'
import { requireGrantableRole } from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { memberId: MemberId; actorId: MemberId }

export const endMemberSessions = ({ transactor }: Dependencies, { memberId, actorId }: Input) =>
  transactor.run(async ({ memberships, workspaceRoles, memberAccess, workspaceEvents }) => {
    const actorPermissions = await requireWorkspacePermission(memberships, actorId, 'members.manage')
    const member = requireActiveMember(await memberships.get(memberId), memberId)
    requireGrantableRole(actorPermissions, await workspaceRoles.get(member.role), member.role)
    await memberAccess.endSessions(memberId)
    await workspaceEvents.record({ type: 'member.sessions_ended', actorId, payload: { memberId } })
  })
