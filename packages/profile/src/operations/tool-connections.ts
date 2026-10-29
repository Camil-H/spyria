import { type MemberId, MemberNotFound, toolNamePartsOf } from '@spyria/kernel'
import type { LlmGateway, ToolGateway, ToolServer } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { ToolNotInCatalog, ToolStillConnected } from '../domain/errors.ts'
import {
  checkedConnectionStatusOf,
  connectedTool,
  connectionStatuses,
  connectionStatusOf,
} from '../domain/personal-connection.ts'
import { memberToolsOf } from '../domain/workspace-connection.ts'
import { grantMemberTools } from './grant-tools.ts'
import { ensureMemberGatewayKey } from './sync-member-gateway-key.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Input = { tool: string }
type ToolCall = { prompterId: MemberId; toolName: string }

const sessionsOf = async ({ transactor, gateway }: Dependencies, { tool }: Input) => {
  const server = (await gateway.toolServers()).find(({ name }) => name === tool)
  const virtualKeyId = await transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKey())
  return server && virtualKeyId ? gateway.toolSessions(virtualKeyId, server) : []
}

const personalServersOf = async (gateway: ToolGateway) =>
  (await gateway.toolServers()).filter(({ isPersonal }) => isPersonal)

export const availableTools = async ({ gateway }: Pick<Dependencies, 'gateway'>) =>
  (await personalServersOf(gateway)).map(({ name }) => name)

export const startToolConnection = async (
  dependencies: { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway },
  { tool }: Input,
) => {
  const { transactor, gateway } = dependencies
  const servers = await gateway.toolServers()
  const server = servers.find(({ name, isPersonal }) => isPersonal && name === tool)
  if (!server) throw new ToolNotInCatalog(tool)
  const virtualKeyId = await ensureMemberGatewayKey(dependencies)
  if (!virtualKeyId) throw new MemberNotFound(transactor.member.memberId)
  await grantMemberTools(dependencies, transactor.member)
  for (const session of await gateway.toolSessions(virtualKeyId, server)) await gateway.removeToolSession(session.id)
  if ((await gateway.toolSessions(virtualKeyId, server)).length > 0) throw new ToolStillConnected(tool)
  return { authorizeUrl: await gateway.startToolConsent(virtualKeyId, server) }
}

export const refreshToolConnection = async (dependencies: Dependencies, { tool }: Input) => {
  const catalog = await availableTools(dependencies)
  const status = connectionStatusOf((await sessionsOf(dependencies, { tool })).map(({ status }) => status))
  await dependencies.transactor.run(({ personalConnections }) =>
    status ? personalConnections.connect(connectedTool(tool, catalog, status)) : personalConnections.disconnect(tool),
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
  const { stored, virtualKeyId } = await transactor.run(async ({ personalConnections, memberGatewayKeys }) => ({
    stored: await personalConnections.tools(),
    virtualKeyId: await memberGatewayKeys.virtualKey(),
  }))
  const servers = virtualKeyId ? await personalServersOf(gateway) : []
  for (const tool of new Set([...stored, ...servers.map(({ name }) => name)])) {
    const server = servers.find(({ name }) => name === tool)
    const checked =
      server && virtualKeyId
        ? await checkedStatusOf(gateway, virtualKeyId, server)
        : { sessionStatus: undefined, isAuthorized: undefined }
    await transactor.run(async ({ personalConnections }) => {
      const status = checkedConnectionStatusOf({ ...checked, storedStatus: await personalConnections.statusOf(tool) })
      await (status ? personalConnections.connect({ tool, status }) : personalConnections.disconnect(tool))
    })
  }
}

export const disconnectTool = async (dependencies: Dependencies, { tool }: Input) => {
  for (const session of await sessionsOf(dependencies, { tool }))
    await dependencies.gateway.removeToolSession(session.id)
  await dependencies.transactor.run(({ personalConnections }) => personalConnections.disconnect(tool))
}

export const flagToolConnection = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(async ({ personalConnections }) => {
    const isConnected = (await personalConnections.statusOf(tool)) !== undefined
    if (isConnected) await personalConnections.connect({ tool, status: connectionStatuses.needsReconnection })
    return isConnected
  })

export const toolServerNameOf = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(
    async ({ workspaceConnections }) =>
      (await workspaceConnections.findByGatewayName(transactor.member.workspaceId, tool))?.name ?? tool,
  )

export const toolCallAccess = async ({ transactor, gateway }: Dependencies, { prompterId, toolName }: ToolCall) => {
  const { workspaceId, memberId: ownerId } = transactor.member
  const { server, tool } = toolNamePartsOf(toolName)
  const isGuest = prompterId !== ownerId
  const { connection, restrictions } = await transactor.run(async ({ workspaceConnections }) => {
    const found = await workspaceConnections.findByGatewayName(workspaceId, server)
    return { connection: found, restrictions: found ? await workspaceConnections.restrictionsOf(workspaceId) : [] }
  })
  if (!connection) {
    const isPersonal = (await gateway.toolServers()).some(({ name, isPersonal }) => isPersonal && name === server)
    if (!isPersonal) return 'not_allowed'
    return isGuest ? 'personal' : 'allowed'
  }
  const isAllowed = [ownerId, prompterId].every((memberId) =>
    memberToolsOf(connection, restrictions, memberId).includes(tool),
  )
  return isAllowed ? 'allowed' : 'not_allowed'
}
