import { type MemberId, MemberNotFound, requirePermissionIn, type WorkspaceId } from '@spyria/kernel'
import type { ToolGateway, WorkspaceConnectionRepository } from '../contracts/repositories.ts'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import {
  ConnectionSetupFailed,
  ConnectionUnreachable,
  DuplicateConnectionName,
  SecretRequired,
} from '../domain/errors.ts'
import {
  allowedAfterRelisting,
  type ConnectionInput,
  connectionInputOf,
  connectionSignIns,
  editedInputOf,
  gatewayNameOf,
  knownToolsOf,
  memberToolsOf,
  type SecretHeader,
} from '../domain/workspace-connection.ts'
import { grantMemberTools, grantWorkspaceTools } from './grant-tools.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type InWorkspace = { workspaceId: WorkspaceId }
type ConnectionTarget = InWorkspace & { connectionId: string }

const asConnectionManager = <Result>({ transactor }: Dependencies, work: (unitOfWork: UnitOfWork) => Promise<Result>) =>
  transactor.run(async (unitOfWork) => {
    requirePermissionIn(await unitOfWork.members.permissions(), 'tools.manage')
    return work(unitOfWork)
  })

const requireFreeName = async (
  workspaceConnections: WorkspaceConnectionRepository,
  workspaceId: WorkspaceId,
  name: string,
) => {
  if (await workspaceConnections.findByName(workspaceId, name)) throw new DuplicateConnectionName(name)
}

const registeredTools = async (
  gateway: ToolGateway,
  server: { name: string; url: string; secretHeader?: SecretHeader | null },
) => {
  const tools = await gateway.addToolServer(server)
  if (tools.length > 0) return tools
  await gateway.removeToolServer(server.name)
  throw new ConnectionUnreachable(server.url)
}

const releaseLostSignIns = async (
  { transactor, gateway }: Dependencies,
  { workspaceId, connectionId }: ConnectionTarget,
) => {
  const { connection, restrictions, virtualKeys } = await transactor.run(
    async ({ workspaceConnections, memberGatewayKeys }) => ({
      connection: await workspaceConnections.get(workspaceId, connectionId),
      restrictions: await workspaceConnections.restrictionsOf(workspaceId),
      virtualKeys: await memberGatewayKeys.virtualKeysIn(workspaceId),
    }),
  )
  if (connection.signIn !== connectionSignIns.member) return
  const server = (await gateway.toolServers()).find(({ name }) => name === connection.gatewayName)
  for (const { memberId, virtualKeyId } of virtualKeys) {
    if (memberToolsOf(connection, restrictions, memberId).length > 0) continue
    for (const session of server ? await gateway.toolSessions(virtualKeyId, server) : [])
      await gateway.removeToolSession(session.id)
    await transactor.run(({ workspaceConnections }) =>
      workspaceConnections.removeSignIn(workspaceId, connectionId, memberId),
    )
  }
}

export const addWorkspaceConnection = async (dependencies: Dependencies, input: InWorkspace & ConnectionInput) => {
  const { workspaceId } = input
  const { name, url, signIn, secretHeader } = connectionInputOf(input)
  const { gateway } = dependencies
  await asConnectionManager(dependencies, ({ workspaceConnections }) =>
    requireFreeName(workspaceConnections, workspaceId, name),
  )
  const gatewayName = gatewayNameOf(name)
  const setup =
    signIn === connectionSignIns.member
      ? await gateway.startMemberToolServer({ name: gatewayName, url }).catch(async (error: unknown) => {
          await gateway.removeToolServer(gatewayName)
          throw error
        })
      : undefined
  const tools = setup ? [] : await registeredTools(gateway, { name: gatewayName, url, secretHeader })
  const connection = {
    workspaceId,
    id: crypto.randomUUID(),
    name,
    gatewayName,
    url,
    signIn,
    setupId: setup?.setupId ?? null,
    headerName: secretHeader?.name ?? null,
    tools,
    allowedTools: tools.map((tool) => tool.name),
  }
  try {
    await asConnectionManager(dependencies, async ({ workspaceConnections, workspaceEvents }) => {
      await requireFreeName(workspaceConnections, workspaceId, name)
      await workspaceConnections.add(connection)
      await workspaceEvents.record({
        workspaceId,
        type: 'connection.added',
        payload: {
          connectionId: connection.id,
          name,
          url,
          signIn,
          hasSecret: Boolean(secretHeader),
        },
      })
    })
  } catch (error) {
    await gateway.removeToolServer(gatewayName)
    throw error
  }
  if (setup) return { connectionId: connection.id, authorizeUrl: setup.authorizeUrl }
  await grantWorkspaceTools(dependencies, workspaceId)
  return { connectionId: connection.id }
}

export const finishWorkspaceConnection = async (dependencies: Dependencies, input: ConnectionTarget) => {
  const { workspaceId, connectionId } = input
  const connection = await asConnectionManager(dependencies, ({ workspaceConnections }) =>
    workspaceConnections.get(workspaceId, connectionId),
  )
  if (connection.setupId === null) return
  const tools = await dependencies.gateway
    .finishMemberToolServer(connection.gatewayName, connection.setupId)
    .catch(async (error: unknown) => {
      await removeWorkspaceConnection(dependencies, input)
      throw error
    })
  if (tools.length === 0) {
    await removeWorkspaceConnection(dependencies, input)
    throw new ConnectionSetupFailed(connection.name)
  }
  await asConnectionManager(dependencies, ({ workspaceConnections }) =>
    workspaceConnections.save({ ...connection, setupId: null, tools, allowedTools: tools.map((tool) => tool.name) }),
  )
  await grantWorkspaceTools(dependencies, workspaceId)
}

export const editWorkspaceConnection = async (
  dependencies: Dependencies,
  input: ConnectionTarget & Omit<ConnectionInput, 'signIn'>,
) => {
  const { workspaceId, connectionId } = input
  const { gateway } = dependencies
  const previous = await asConnectionManager(dependencies, async ({ workspaceConnections }) => {
    const found = await workspaceConnections.get(workspaceId, connectionId)
    if (input.name.trim() !== found.name) await requireFreeName(workspaceConnections, workspaceId, input.name.trim())
    return found
  })
  const { name, url, secretHeader } = editedInputOf(previous, input)
  const isUrlChanged = url !== previous.url
  if (isUrlChanged && previous.headerName && secretHeader === undefined) throw new SecretRequired(previous.headerName)
  const gatewayName = isUrlChanged ? gatewayNameOf(name) : previous.gatewayName
  const tools = isUrlChanged ? await registeredTools(gateway, { name: gatewayName, url, secretHeader }) : previous.tools
  if (!isUrlChanged && secretHeader !== undefined) await gateway.replaceToolServerHeader(gatewayName, secretHeader)
  const connection = {
    ...previous,
    name,
    url,
    gatewayName,
    tools,
    allowedTools: allowedAfterRelisting(previous, tools),
    headerName: secretHeader === undefined ? previous.headerName : (secretHeader?.name ?? null),
  }
  await asConnectionManager(dependencies, async ({ workspaceConnections, workspaceEvents }) => {
    await workspaceConnections.save(connection)
    await workspaceEvents.record({
      workspaceId,
      type: 'connection.updated',
      payload: { connectionId, name, url, isSecretReplaced: secretHeader !== undefined },
    })
  })
  if (!isUrlChanged) return
  await gateway.removeToolServer(previous.gatewayName)
  await grantWorkspaceTools(dependencies, workspaceId)
}

export const removeWorkspaceConnection = async (dependencies: Dependencies, input: ConnectionTarget) => {
  const { workspaceId, connectionId } = input
  const connection = await asConnectionManager(dependencies, ({ workspaceConnections }) =>
    workspaceConnections.get(workspaceId, connectionId),
  )
  await dependencies.gateway.removeToolServer(connection.gatewayName)
  await asConnectionManager(dependencies, async ({ workspaceConnections, workspaceEvents }) => {
    await workspaceConnections.remove(workspaceId, connectionId)
    await workspaceEvents.record({
      workspaceId,
      type: 'connection.removed',
      payload: { connectionId, name: connection.name },
    })
  })
}

export const allowConnectionTools = async (
  dependencies: Dependencies,
  input: ConnectionTarget & { allowedTools: string[] },
) => {
  const { workspaceId, connectionId } = input
  await asConnectionManager(dependencies, async ({ workspaceConnections, workspaceEvents }) => {
    const connection = await workspaceConnections.get(workspaceId, connectionId)
    const allowedTools = knownToolsOf(connection, input.allowedTools)
    await workspaceConnections.save({ ...connection, allowedTools })
    await workspaceEvents.record({
      workspaceId,
      type: 'connection.updated',
      payload: { connectionId, allowedTools },
    })
  })
  await grantWorkspaceTools(dependencies, workspaceId)
  await releaseLostSignIns(dependencies, input)
}

export const restrictConnectionMember = async (
  dependencies: Dependencies,
  input: ConnectionTarget & { memberId: MemberId; allowedTools: string[] | null },
) => {
  const { workspaceId, connectionId, memberId } = input
  await asConnectionManager(dependencies, async ({ members, workspaceConnections, workspaceEvents }) => {
    if (!(await members.isActive(workspaceId, memberId))) throw new MemberNotFound(memberId)
    const connection = await workspaceConnections.get(workspaceId, connectionId)
    const allowedTools = input.allowedTools && knownToolsOf(connection, input.allowedTools)
    if (allowedTools) await workspaceConnections.restrict(workspaceId, { connectionId, memberId, allowedTools })
    else await workspaceConnections.unrestrict(workspaceId, connectionId, memberId)
    await workspaceEvents.record({
      workspaceId,
      type: 'connection.restricted',
      payload: { connectionId, memberId, allowedTools },
    })
  })
  await grantMemberTools(dependencies, { workspaceId, memberId })
  await releaseLostSignIns(dependencies, input)
}
