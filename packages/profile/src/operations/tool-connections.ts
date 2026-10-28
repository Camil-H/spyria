import { type MemberId, MemberNotFound, toolNamePartsOf, type WorkspaceId } from '@spyria/kernel'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { ToolNotInCatalog, ToolStillConnected } from '../domain/errors.ts'
import { connectedTool, connectionStatuses, connectionStatusOf } from '../domain/personal-connection.ts'
import { memberToolsOf } from '../domain/workspace-connection.ts'
import { grantMemberTools } from './grant-tools.ts'
import { ensureMemberGatewayKey } from './sync-member-gateway-key.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Member = { workspaceId: WorkspaceId; memberId: MemberId }
type Input = Member & { tool: string }
type ToolCall = { workspaceId: WorkspaceId; ownerId: MemberId; prompterId: MemberId; toolName: string }

const virtualKeyOf = ({ transactor }: Dependencies, { workspaceId, memberId }: Member) =>
  transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKeyOf(workspaceId, memberId))

const sessionsOf = async (dependencies: Dependencies, { tool, ...member }: Input) => {
  const server = (await dependencies.gateway.toolServers()).find(({ name }) => name === tool)
  const virtualKeyId = await virtualKeyOf(dependencies, member)
  return server && virtualKeyId ? dependencies.gateway.toolSessions(virtualKeyId, server) : []
}

const personalServersOf = async (gateway: ToolGateway) =>
  (await gateway.toolServers()).filter(({ isPersonal }) => isPersonal)

export const availableTools = async ({ gateway }: Pick<Dependencies, 'gateway'>) =>
  (await personalServersOf(gateway)).map(({ name }) => name)

export const startToolConnection = async (
  dependencies: { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway },
  input: Input,
) => {
  const { gateway } = dependencies
  const servers = await gateway.toolServers()
  const server = servers.find(({ name, isPersonal }) => isPersonal && name === input.tool)
  if (!server) throw new ToolNotInCatalog(input.tool)
  const virtualKeyId = await ensureMemberGatewayKey(dependencies, input)
  if (!virtualKeyId) throw new MemberNotFound(input.memberId)
  await grantMemberTools(dependencies, input)
  for (const session of await gateway.toolSessions(virtualKeyId, server)) await gateway.removeToolSession(session.id)
  if ((await gateway.toolSessions(virtualKeyId, server)).length > 0) throw new ToolStillConnected(input.tool)
  return { authorizeUrl: await gateway.startToolConsent(virtualKeyId, server) }
}

export const refreshToolConnection = async (dependencies: Dependencies, { tool, ...member }: Input) => {
  const catalog = await availableTools(dependencies)
  const status = connectionStatusOf((await sessionsOf(dependencies, { tool, ...member })).map(({ status }) => status))
  await dependencies.transactor.run(({ personalConnections }) =>
    status
      ? personalConnections.connect(connectedTool(member, tool, catalog, status))
      : personalConnections.disconnect(member.workspaceId, member.memberId, tool),
  )
  return { status: status ?? null }
}

export const disconnectTool = async (dependencies: Dependencies, input: Input) => {
  for (const session of await sessionsOf(dependencies, input)) await dependencies.gateway.removeToolSession(session.id)
  await dependencies.transactor.run(({ personalConnections }) =>
    personalConnections.disconnect(input.workspaceId, input.memberId, input.tool),
  )
}

export const flagToolConnection = ({ transactor }: Pick<Dependencies, 'transactor'>, input: Input) =>
  transactor.run(async ({ personalConnections }) => {
    const isConnected =
      (await personalConnections.statusOf(input.workspaceId, input.memberId, input.tool)) !== undefined
    if (isConnected) await personalConnections.connect({ ...input, status: connectionStatuses.needsReconnection })
    return isConnected
  })

export const toolCallAccess = async (
  { transactor, gateway }: Dependencies,
  { workspaceId, ownerId, prompterId, toolName }: ToolCall,
) => {
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
