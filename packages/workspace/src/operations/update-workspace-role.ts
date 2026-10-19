import { type MemberId, requireWorkspacePermission } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import {
  customWorkspaceRoleOf,
  requireCustomRole,
  requireGrantableRole,
  requireUniqueRoleName,
} from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { roleId: string; name: string; permissions: readonly string[]; actorId: MemberId }

export const updateWorkspaceRole = ({ transactor }: Dependencies, { roleId, actorId, ...input }: Input) =>
  transactor.run(async ({ memberships, workspaceRoles, workspaceEvents }) => {
    const actorPermissions = await requireWorkspacePermission(memberships, actorId, 'roles.manage')
    requireGrantableRole(actorPermissions, requireCustomRole(await workspaceRoles.get(roleId), roleId), roleId)
    const role = requireGrantableRole(actorPermissions, customWorkspaceRoleOf({ id: roleId, ...input }), roleId)
    requireUniqueRoleName(role, await workspaceRoles.list())
    await workspaceRoles.save(role)
    await workspaceEvents.record({
      type: 'workspace_role.updated',
      actorId,
      payload: { roleId, name: role.name, permissions: role.permissions },
    })
  })
