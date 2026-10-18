import type { MemberId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { customChatRoleOf, requireCustomRole, requireUniqueRoleName } from '../domain/chat-role.ts'
import { requireAdmin } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { roleId: string; name: string; permissions: readonly string[]; actorId: MemberId }

export const updateChatRole = ({ transactor }: Dependencies, { roleId, actorId, ...input }: Input) =>
  transactor.run(async ({ memberships, chatRoles, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId), 'manage roles')
    requireCustomRole(await chatRoles.get(roleId), roleId)
    const role = customChatRoleOf({ id: roleId, ...input })
    requireUniqueRoleName(role, await chatRoles.list())
    await chatRoles.save(role)
    await workspaceEvents.record({
      type: 'role.updated',
      actorId,
      payload: { roleId, name: role.name, permissions: role.permissions },
    })
  })
