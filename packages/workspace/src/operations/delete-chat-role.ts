import type { MemberId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireCustomRole, requireUnheldRole } from '../domain/chat-role.ts'
import { requireAdmin } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { roleId: string; actorId: MemberId }

export const deleteChatRole = ({ transactor }: Dependencies, { roleId, actorId }: Input) =>
  transactor.run(async ({ memberships, chatRoles, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId), 'manage roles')
    const role = requireCustomRole(await chatRoles.get(roleId), roleId)
    requireUnheldRole(role, await chatRoles.holders(roleId))
    await chatRoles.remove(roleId)
    await workspaceEvents.record({ type: 'role.deleted', actorId, payload: { roleId, name: role.name } })
  })
