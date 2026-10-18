import type { MemberId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { customChatRoleOf, requireUniqueRoleName } from '../domain/chat-role.ts'
import { requireAdmin } from '../domain/member.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; name: string; permissions: readonly string[]; actorId: MemberId }

export const createChatRole = ({ transactor }: Dependencies, { actorId, ...input }: Input) =>
  transactor.run(async ({ memberships, chatRoles, workspaceEvents }) => {
    requireAdmin(await memberships.get(actorId), 'manage roles')
    const role = customChatRoleOf(input)
    requireUniqueRoleName(role, await chatRoles.list())
    await chatRoles.add(role)
    await workspaceEvents.record({
      type: 'role.created',
      actorId,
      payload: { roleId: role.id, name: role.name, permissions: role.permissions },
    })
  })
