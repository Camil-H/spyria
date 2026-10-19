import { type MemberId, requireWorkspacePermission } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { customWorkspaceRoleOf, requireGrantableRole, requireUniqueRoleName } from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; name: string; permissions: readonly string[]; actorId: MemberId }

export const createWorkspaceRole = ({ transactor }: Dependencies, { actorId, ...input }: Input) =>
  transactor.run(async ({ memberships, workspaceRoles, workspaceEvents }) => {
    const actorPermissions = await requireWorkspacePermission(memberships, actorId, 'roles.manage')
    const role = requireGrantableRole(actorPermissions, customWorkspaceRoleOf(input), input.id)
    requireUniqueRoleName(role, await workspaceRoles.list())
    await workspaceRoles.add(role)
    await workspaceEvents.record({
      type: 'workspace_role.created',
      actorId,
      payload: { roleId: role.id, name: role.name, permissions: role.permissions },
    })
  })
