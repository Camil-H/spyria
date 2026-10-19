import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireCustomRole, requireGrantableRole, requireUnheldWorkspaceRole } from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { roleId: string; actorId: MemberId }

export const deleteWorkspaceRole = ({ transactor }: Dependencies, { roleId, actorId }: Input) =>
  transactor.run(async ({ memberships, workspaceRoles, workspaceEvents }) => {
    const actorPermissions = await requireWorkspacePermission(memberships, actorId, 'roles.manage')
    const role = requireGrantableRole(
      actorPermissions,
      requireCustomRole(await workspaceRoles.get(roleId), roleId),
      roleId,
    )
    requireUnheldWorkspaceRole(role, await workspaceRoles.holders(roleId))
    await workspaceRoles.remove(roleId)
    await workspaceEvents.record({ type: 'workspace_role.deleted', actorId, payload: { roleId, name: role.name } })
  })
