import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { NoGatewayKey, ToolNotInCatalog } from '../domain/errors.ts'
import { connectedTool, connectionStatusOf } from '../domain/personal-connection.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Member = { workspaceId: WorkspaceId; memberId: MemberId }
type Input = Member & { tool: string }

const virtualKeyOf = ({ transactor }: Dependencies, { workspaceId, memberId }: Member) =>
  transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKeyOf(workspaceId, memberId))

const sessionsOf = async (dependencies: Dependencies, { tool, ...member }: Input) => {
  const server = (await dependencies.gateway.toolServers()).find(({ name }) => name === tool)
  const virtualKeyId = await virtualKeyOf(dependencies, member)
  return server && virtualKeyId ? dependencies.gateway.toolSessions(virtualKeyId, server) : []
}

export const availableTools = async ({ gateway }: Pick<Dependencies, 'gateway'>) =>
  (await gateway.toolServers()).map(({ name }) => name)

export const grantAvailableTools = async (dependencies: Dependencies, member: Member) => {
  const virtualKeyId = await virtualKeyOf(dependencies, member)
  if (virtualKeyId) await dependencies.gateway.grantToolServers(virtualKeyId, await dependencies.gateway.toolServers())
}

export const startToolConnection = async (dependencies: Dependencies, input: Input) => {
  const { gateway } = dependencies
  const servers = await gateway.toolServers()
  const server = servers.find(({ name }) => name === input.tool)
  if (!server) throw new ToolNotInCatalog(input.tool)
  const virtualKeyId = await virtualKeyOf(dependencies, input)
  if (!virtualKeyId) throw new NoGatewayKey()
  await gateway.grantToolServers(virtualKeyId, servers)
  for (const session of await gateway.toolSessions(virtualKeyId, server)) await gateway.removeToolSession(session.id)
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
    if (isConnected) await personalConnections.connect({ ...input, status: 'Needs reconnection' })
    return isConnected
  })
