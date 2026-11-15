import {
  type ConnectionTool,
  grantedToolsOf,
  type MemberId,
  MemberNotFound,
  type ToolApproval,
  toolApprovalOf,
  toolNamePartsOf,
  type WorkspaceId,
} from '@spyria/kernel'
import type { LlmGateway, ToolGateway, ToolServer } from '../contracts/repositories.ts'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { ToolConnectionsNotChecked, ToolNotInCatalog, ToolStillConnected } from '../domain/errors.ts'
import { checkedConnectionStatusOf, connectionStatuses, connectionStatusOf } from '../domain/tool-connection.ts'
import {
  canSignIn,
  connectionSignIns,
  type ToolHolder,
  type WorkspaceConnection,
} from '../domain/workspace-connection.ts'
import { grantMemberTools } from './grant-tools.ts'
import { ensureMemberGatewayKey } from './sync-member-gateway-key.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Input = { tool: string }
type ToolCall = { ownerId: MemberId; prompterId: MemberId; toolName: string }

type ToolCallPolicy = {
  access: 'allowed' | 'not_granted' | 'not_shared'
  readOnly: boolean | null
  approval: ToolApproval
  answerer: 'prompter' | 'owner'
}

const holderIn = (holders: readonly ToolHolder[], memberId: MemberId) =>
  holders.find((holder) => holder.memberId === memberId)

const signInServerOf = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(async ({ workspaceConnections, members }) => {
    const { workspaceId, memberId } = transactor.member
    const connection = await workspaceConnections.findByName(workspaceId, tool)
    const accessRows = connection ? await workspaceConnections.accessOf(workspaceId) : []
    const holder = connection && holderIn(await members.holders(workspaceId), memberId)
    if (!connection || !holder || !canSignIn(connection, accessRows, holder)) throw new ToolNotInCatalog(tool)
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

const syncToolConnectionsLater = ({ transactor }: Pick<Dependencies, 'transactor'>) =>
  transactor.run(({ gatewayJobs }) => gatewayJobs.syncToolConnectionsLater(transactor.member.memberId))

export const refreshToolConnection = async (dependencies: Dependencies, { tool }: Input) => {
  await signInServerOf(dependencies, { tool })
  await syncToolConnectionsLater(dependencies)
}

export const checkToolConnections = (dependencies: Dependencies) => syncToolConnectionsLater(dependencies)

const checkedStatusOf = async (gateway: ToolGateway, virtualKeyId: string, server: ToolServer) => {
  const sessionStatusOf = async () =>
    connectionStatusOf((await gateway.toolSessions(virtualKeyId, server)).map(({ status }) => status))
  const sessionStatus = await sessionStatusOf()
  if (sessionStatus !== connectionStatuses.connected) return { sessionStatus, isAuthorized: undefined }
  const isAuthorized = await gateway.isToolSessionAuthorized(virtualKeyId, server)
  return { sessionStatus: await sessionStatusOf(), isAuthorized }
}

const signInConnectionsOf = async (
  { workspaceConnections, members }: Pick<UnitOfWork, 'workspaceConnections' | 'members'>,
  { workspaceId, memberId }: { workspaceId: WorkspaceId; memberId: MemberId },
) => {
  const accessRows = await workspaceConnections.accessOf(workspaceId)
  const holder = holderIn(await members.holders(workspaceId), memberId)
  return (await workspaceConnections.list(workspaceId)).filter(
    (connection) => holder !== undefined && canSignIn(connection, accessRows, holder),
  )
}

const notCheckedStatus = { sessionStatus: undefined, isAuthorized: undefined }

export const syncToolConnections = async ({ transactor, gateway }: Dependencies) => {
  const { member } = transactor
  const { stored, connections, virtualKeyId } = await transactor.run(async (unitOfWork) => ({
    stored: await unitOfWork.toolConnections.connectionIds(),
    connections: await signInConnectionsOf(unitOfWork, member),
    virtualKeyId: await unitOfWork.memberGatewayKeys.virtualKey(),
  }))
  const servers = virtualKeyId ? await gateway.toolServers() : []
  const checkedById = new Map(
    await Promise.all(
      connections.map(async ({ id, gatewayName }) => {
        const server = servers.find(({ name }) => name === gatewayName)
        if (!server || !virtualKeyId) return [id, notCheckedStatus] as const
        return [id, await checkedStatusOf(gateway, virtualKeyId, server).catch(() => undefined)] as const
      }),
    ),
  )
  const isActive = await transactor.run(async (unitOfWork) => {
    const { members, toolConnections } = unitOfWork
    if (!(await members.lockIfActive())) return false
    const signInIds = new Set((await signInConnectionsOf(unitOfWork, member)).map(({ id }) => id))
    const storedNow = await toolConnections.connectionIds()
    for (const connectionId of new Set([...stored, ...storedNow, ...checkedById.keys()])) {
      const storedStatus = await toolConnections.statusOf(connectionId)
      const isSignInAllowed = signInIds.has(connectionId)
      const checked = checkedById.has(connectionId) ? checkedById.get(connectionId) : notCheckedStatus
      if (isSignInAllowed && !checked) continue
      const status = isSignInAllowed && checked ? checkedConnectionStatusOf({ ...checked, storedStatus }) : undefined
      if (status === storedStatus) continue
      await (status ? toolConnections.connect({ connectionId, status }) : toolConnections.disconnect(connectionId))
    }
    return true
  })
  const uncheckedNames = connections.filter(({ id }) => !checkedById.get(id)).map(({ name }) => name)
  if (isActive && uncheckedNames.length > 0) throw new ToolConnectionsNotChecked(uncheckedNames.join(', '))
}

export const disconnectTool = async (dependencies: Dependencies, { tool }: Input) => {
  const connection = await dependencies.transactor.run(({ workspaceConnections }) =>
    workspaceConnections.findByName(dependencies.transactor.member.workspaceId, tool),
  )
  if (connection?.signIn !== connectionSignIns.member) throw new ToolNotInCatalog(tool)
  for (const session of await sessionsOf(dependencies, connection))
    await dependencies.gateway.removeToolSession(session.id)
  await syncToolConnectionsLater(dependencies)
}

export const flagToolConnection = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(async ({ members, toolConnections, workspaceConnections, gatewayJobs }) => {
    const connection = await workspaceConnections.findByGatewayName(transactor.member.workspaceId, tool)
    const isConnected =
      connection !== undefined &&
      (await members.lockIfActive()) &&
      (await toolConnections.statusOf(connection.id)) !== undefined
    if (!isConnected) return false
    await toolConnections.connect({ connectionId: connection.id, status: connectionStatuses.needsReconnection })
    await gatewayJobs.syncToolConnectionsLater(transactor.member.memberId)
    return true
  })

export const toolServerNameOf = ({ transactor }: Pick<Dependencies, 'transactor'>, { tool }: Input) =>
  transactor.run(
    async ({ workspaceConnections }) =>
      (await workspaceConnections.findByGatewayName(transactor.member.workspaceId, tool))?.name ?? tool,
  )

export const catalogueServersOf = ({ transactor }: Pick<Dependencies, 'transactor'>) =>
  transactor.run(async ({ workspaceConnections }) =>
    (await workspaceConnections.list(transactor.member.workspaceId)).map(({ id, gatewayName }) => ({
      id,
      gatewayName,
    })),
  )

export const toolCallPolicy = async (
  { transactor }: Pick<Dependencies, 'transactor'>,
  { ownerId, prompterId, toolName }: ToolCall,
): Promise<ToolCallPolicy> => {
  const { workspaceId } = transactor.member
  const { server, tool: toolOnServer } = toolNamePartsOf(toolName)
  return transactor.run(async ({ workspaceConnections, members, toolApprovals }) => {
    const connection = await workspaceConnections.findByGatewayName(workspaceId, server)
    const tool: ConnectionTool | undefined = connection?.tools.find(({ name }) => name === toolOnServer)
    if (!connection || !tool) return { access: 'not_granted', readOnly: null, approval: 'never', answerer: 'prompter' }
    const accessRows = await workspaceConnections.accessOf(workspaceId)
    const holders = await members.holders(workspaceId)
    const isShared = connection.signIn === connectionSignIns.shared
    const preference = await toolApprovals.ofMember(isShared ? ownerId : prompterId, connection.id)
    const isGranted = (memberId: MemberId) => {
      const holder = holderIn(holders, memberId)
      return holder !== undefined && grantedToolsOf(connection, accessRows, holder).includes(tool.name)
    }
    const access = !isGranted(prompterId) ? 'not_granted' : isShared && !isGranted(ownerId) ? 'not_shared' : 'allowed'
    return {
      access,
      readOnly: tool.readOnly,
      approval: toolApprovalOf(connection, tool, preference),
      answerer: isShared ? 'owner' : 'prompter',
    }
  })
}
