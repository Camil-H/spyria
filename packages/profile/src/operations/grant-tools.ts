import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { memberToolsOf } from '../domain/workspace-connection.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Member = { workspaceId: WorkspaceId; memberId: MemberId }

export const grantWorkspaceTools = async (
  { transactor, gateway }: Dependencies,
  workspaceId: WorkspaceId,
  memberIds?: readonly MemberId[],
) => {
  const { connections, restrictions, virtualKeys } = await transactor.run(
    async ({ workspaceConnections, memberGatewayKeys }) => ({
      connections: await workspaceConnections.list(workspaceId),
      restrictions: await workspaceConnections.restrictionsOf(workspaceId),
      virtualKeys: await memberGatewayKeys.virtualKeysIn(workspaceId),
    }),
  )
  for (const { memberId, virtualKeyId } of virtualKeys.filter((key) => memberIds?.includes(key.memberId) ?? true))
    await gateway.setToolGrants(
      virtualKeyId,
      Object.fromEntries(
        connections.map((connection) => [connection.gatewayName, memberToolsOf(connection, restrictions, memberId)]),
      ),
    )
}

export const grantMemberTools = (dependencies: Dependencies, { workspaceId, memberId }: Member) =>
  grantWorkspaceTools(dependencies, workspaceId, [memberId])
