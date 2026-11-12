import { type MemberId, MemberNotFound, toolNamePartsOf } from '@spyria/kernel'
import type { LlmGateway, ToolGateway, ToolServer } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { ToolNotInCatalog, ToolStillConnected } from '../domain/errors.ts'
import { checkedConnectionStatusOf, connectionStatuses, connectionStatusOf } from '../domain/tool-connection.ts'
import {
  canSignIn,
  connectionSignIns,
  memberToolsOf,
  type WorkspaceConnection,
} from '../domain/workspace-connection.ts'
import { grantMemberTools } from './grant-tools.ts'
import { ensureMemberGatewayKey } from './sync-member-gateway-key.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Input = { tool: string }
type ToolCall = { prompterId: MemberId; toolName: string }

const signInServerOf = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(async ({ workspaceConnections }) => {
    const { workspaceId, memberId } = transactor.member
    const connection = await workspaceConnections.findByName(workspaceId, tool)
    const restrictions = connection ? await workspaceConnections.restrictionsOf(workspaceId) : []
    if (!connection || !canSignIn(connection, restrictions, memberId)) throw new ToolNotInCatalog(tool)
    return connection
  })

const gatewayServerOf = async (gateway: ToolGateway, connection: WorkspaceConnection) =>
  (await gateway.toolServers()).find(({ name }) => name === connection.gatewayName)

const sessionsOf = async ({ transactor, gateway }: Dependencies, connection: WorkspaceConnection) => {
  const server = await gatewayServerOf(gateway, connection)
  const virtualKeyId = await transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKey())
  return server && virtualKeyId ? gateway.toolSessions(virtualKeyId, server) : []
}

export const startToolConnection = async (
  dependencies: { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway },
  { tool }: Input,
) => {
  const { transactor, gateway } = dependencies
  const server = await gatewayServerOf(gateway, await signInServerOf(dependencies, { tool }))
  if (!server) throw new ToolNotInCatalog(tool)
  const virtualKeyId = await ensureMemberGatewayKey(dependencies)
  if (!virtualKeyId) throw new MemberNotFound(transactor.member.memberId)
  await grantMemberTools(dependencies, transactor.member)
  for (const session of await gateway.toolSessions(virtualKeyId, server)) await gateway.removeToolSession(session.id)
  if ((await gateway.toolSessions(virtualKeyId, server)).length > 0) throw new ToolStillConnected(tool)
  return { authorizeUrl: await gateway.startToolConsent(virtualKeyId, server) }
}

export const refreshToolConnection = async (dependencies: Dependencies, { tool }: Input) => {
  const connection = await signInServerOf(dependencies, { tool })
  const status = connectionStatusOf((await sessionsOf(dependencies, connection)).map(({ status }) => status))
  await dependencies.transactor.run(({ toolConnections }) =>
    status
      ? toolConnections.connect({ connectionId: connection.id, status })
      : toolConnections.disconnect(connection.id),
  )
  return { status: status ?? null }
}

const checkedStatusOf = async (gateway: ToolGateway, virtualKeyId: string, server: ToolServer) => {
  const sessionStatusOf = async () =>
    connectionStatusOf((await gateway.toolSessions(virtualKeyId, server)).map(({ status }) => status))
  const sessionStatus = await sessionStatusOf()
  if (sessionStatus !== connectionStatuses.connected) return { sessionStatus, isAuthorized: undefined }
  const isAuthorized = await gateway.isToolSessionAuthorized(virtualKeyId, server)
  return { sessionStatus: await sessionStatusOf(), isAuthorized }
}

export const checkToolConnections = async ({ transactor, gateway }: Dependencies) => {
  const { workspaceId, memberId } = transactor.member
  const { stored, connections, virtualKeyId } = await transactor.run(
    async ({ toolConnections, workspaceConnections, memberGatewayKeys }) => {
      const restrictions = await workspaceConnections.restrictionsOf(workspaceId)
      return {
        stored: await toolConnections.connectionIds(),
        connections: (await workspaceConnections.list(workspaceId)).filter((connection) =>
          canSignIn(connection, restrictions, memberId),
        ),
        virtualKeyId: await memberGatewayKeys.virtualKey(),
      }
    },
  )
  const servers = virtualKeyId ? await gateway.toolServers() : []
  for (const connectionId of new Set([...stored, ...connections.map(({ id }) => id)])) {
    const gatewayName = connections.find(({ id }) => id === connectionId)?.gatewayName
    const server = servers.find(({ name }) => name === gatewayName)
    const checked =
      server && virtualKeyId
        ? await checkedStatusOf(gateway, virtualKeyId, server)
        : { sessionStatus: undefined, isAuthorized: undefined }
    await transactor.run(async ({ toolConnections }) => {
      const status = checkedConnectionStatusOf({
        ...checked,
        storedStatus: await toolConnections.statusOf(connectionId),
      })
      await (status ? toolConnections.connect({ connectionId, status }) : toolConnections.disconnect(connectionId))
    })
  }
}

export const disconnectTool = async (dependencies: Dependencies, { tool }: Input) => {
  const connection = await dependencies.transactor.run(({ workspaceConnections }) =>
    workspaceConnections.findByName(dependencies.transactor.member.workspaceId, tool),
  )
  if (connection?.signIn !== connectionSignIns.member) throw new ToolNotInCatalog(tool)
  for (const session of await sessionsOf(dependencies, connection))
    await dependencies.gateway.removeToolSession(session.id)
  await dependencies.transactor.run(({ toolConnections }) => toolConnections.disconnect(connection.id))
}

export const flagToolConnection = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(async ({ toolConnections, workspaceConnections }) => {
    const connection = await workspaceConnections.findByGatewayName(transactor.member.workspaceId, tool)
    const isConnected = connection !== undefined && (await toolConnections.statusOf(connection.id)) !== undefined
    if (isConnected)
      await toolConnections.connect({ connectionId: connection.id, status: connectionStatuses.needsReconnection })
    return isConnected
  })

export const toolServerNameOf = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(
    async ({ workspaceConnections }) =>
      (await workspaceConnections.findByGatewayName(transactor.member.workspaceId, tool))?.name ?? tool,
  )

export const toolCallAccess = async (
  { transactor }: Pick<Dependencies, 'transactor'>,
  { prompterId, toolName }: ToolCall,
) => {
  const { workspaceId, memberId: ownerId } = transactor.member
  const { server, tool } = toolNamePartsOf(toolName)
  const { connection, restrictions } = await transactor.run(async ({ workspaceConnections }) => {
    const found = await workspaceConnections.findByGatewayName(workspaceId, server)
    return { connection: found, restrictions: found ? await workspaceConnections.restrictionsOf(workspaceId) : [] }
  })
  if (!connection) return 'not_allowed'
  if (connection.signIn === connectionSignIns.member && prompterId !== ownerId) return 'owner_account'
  const isAllowed = [ownerId, prompterId].every((memberId) =>
    memberToolsOf(connection, restrictions, memberId).includes(tool),
  )
  return isAllowed ? 'allowed' : 'not_allowed'
}
