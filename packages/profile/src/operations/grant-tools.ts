import { grantedToolsOf, type MemberId, type WorkspaceId } from '@spyria/kernel'
import type { ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { connectionSignIns } from '../domain/workspace-connection.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Member = { workspaceId: WorkspaceId; memberId: MemberId }

export const grantWorkspaceTools = async (
  { transactor, gateway }: Dependencies,
  workspaceId: WorkspaceId,
  memberIds?: readonly MemberId[],
) => {
  const { connections, accessRows, holders, virtualKeys } = await transactor.run(
    async ({ workspaceConnections, memberGatewayKeys, members }) => ({
      connections: await workspaceConnections.list(workspaceId),
      accessRows: await workspaceConnections.accessOf(workspaceId),
      holders: await members.holders(workspaceId),
      virtualKeys: await memberGatewayKeys.virtualKeysIn(workspaceId),
    }),
  )
  for (const { memberId, virtualKeyId } of virtualKeys.filter((key) => memberIds?.includes(key.memberId) ?? true)) {
    const holder = holders.find((candidate) => candidate.memberId === memberId)
    await gateway.setToolGrants(
      virtualKeyId,
      Object.fromEntries(
        connections.map((connection) => [
          connection.gatewayName,
          holder ? grantedToolsOf(connection, accessRows, holder) : [],
        ]),
      ),
    )
  }
}

export const grantMemberTools = (dependencies: Dependencies, { workspaceId, memberId }: Member) =>
  grantWorkspaceTools(dependencies, workspaceId, [memberId])

export const releaseLostSignIns = async (
  { transactor, gateway }: Dependencies,
  workspaceId: WorkspaceId,
  { connectionId, memberIds }: { connectionId?: string; memberIds?: readonly MemberId[] },
) => {
  const { connections, accessRows, holders, virtualKeys } = await transactor.run(
    async ({ workspaceConnections, memberGatewayKeys, members }) => ({
      connections: (await workspaceConnections.list(workspaceId)).filter(
        (connection) =>
          connection.signIn === connectionSignIns.member &&
          (connectionId === undefined || connection.id === connectionId),
      ),
      accessRows: await workspaceConnections.accessOf(workspaceId),
      holders: await members.holders(workspaceId),
      virtualKeys: await memberGatewayKeys.virtualKeysIn(workspaceId),
    }),
  )
  if (connections.length === 0) return
  const servers = await gateway.toolServers()
  for (const connection of connections) {
    const server = servers.find(({ name }) => name === connection.gatewayName)
    for (const { memberId, virtualKeyId } of virtualKeys.filter((key) => memberIds?.includes(key.memberId) ?? true)) {
      const holder = holders.find((candidate) => candidate.memberId === memberId)
      if (holder && grantedToolsOf(connection, accessRows, holder).length > 0) continue
      for (const session of server ? await gateway.toolSessions(virtualKeyId, server) : [])
        await gateway.removeToolSession(session.id)
      await transactor.run(({ workspaceConnections }) =>
        workspaceConnections.removeSignIn(workspaceId, connection.id, memberId),
      )
    }
  }
}
