import { type MemberId, requireWorkspacePermission } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireCustomRole, requireUnheldRole } from '../domain/role.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { roleId: string; actorId: MemberId }

export const deleteChatRole = ({ transactor }: Dependencies, { roleId, actorId }: Input) =>
  transactor.run(async ({ memberships, chatRoles, workspaceEvents }) => {
    await requireWorkspacePermission(memberships, actorId, 'roles.manage')
    const role = requireCustomRole(await chatRoles.get(roleId), roleId)
    requireUnheldRole(role, await chatRoles.holders(roleId))
    await chatRoles.remove(roleId)
    await workspaceEvents.record({ type: 'role.deleted', actorId, payload: { roleId, name: role.name } })
  })
