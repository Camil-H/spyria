import { grantedToolsOf, MemberNotFound, requirePermissionIn, type WorkspaceId } from '@spyria/kernel'
import type { ToolGateway, WorkspaceConnectionRepository } from '../contracts/repositories.ts'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import {
  ConnectionSetupFailed,
  ConnectionUnreachable,
  DuplicateConnectionName,
  InvalidConnection,
  SecretRequired,
} from '../domain/errors.ts'
import {
  type AccessInput,
  accessOf,
  type ConnectionInput,
  connectionInputOf,
  connectionSignIns,
  editedInputOf,
  gatewayNameOf,
  markedToolsOf,
  relistedToolsOf,
  type SecretHeader,
  type ToolMarking,
} from '../domain/workspace-connection.ts'
import { grantMemberTools, grantWorkspaceTools, releaseLostSignIns } from './grant-tools.ts'

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
    isReviewed: false,
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
  return setup ? { connectionId: connection.id, authorizeUrl: setup.authorizeUrl } : { connectionId: connection.id }
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
    workspaceConnections.save({ ...connection, setupId: null, tools }),
  )
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
  const tools = isUrlChanged
    ? relistedToolsOf(previous, await registeredTools(gateway, { name: gatewayName, url, secretHeader }))
    : previous.tools
  if (!isUrlChanged && secretHeader !== undefined) await gateway.replaceToolServerHeader(gatewayName, secretHeader)
  const connection = {
    ...previous,
    name,
    url,
    gatewayName,
    tools,
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

export const reviewConnectionTools = async (
  dependencies: Dependencies,
  input: ConnectionTarget & { markings: ToolMarking[] },
) => {
  const { workspaceId, connectionId } = input
  await asConnectionManager(dependencies, async ({ workspaceConnections, workspaceEvents }) => {
    const connection = await workspaceConnections.get(workspaceId, connectionId)
    const tools = markedToolsOf(connection, input.markings)
    await workspaceConnections.save({ ...connection, tools, isReviewed: true })
    await workspaceEvents.record({
      workspaceId,
      type: 'connection.reviewed',
      payload: { connectionId, readTools: tools.filter((tool) => tool.readOnly).map(({ name }) => name) },
    })
  })
  await grantWorkspaceTools(dependencies, workspaceId)
  await releaseLostSignIns(dependencies, workspaceId, { connectionId })
}

export const setConnectionAccess = async (dependencies: Dependencies, input: ConnectionTarget & AccessInput) => {
  const { workspaceId, connectionId } = input
  const subject = input.roleId === undefined ? { memberId: input.memberId } : { roleId: input.roleId }
  await asConnectionManager(dependencies, async ({ members, workspaceConnections, workspaceEvents }) => {
    if (subject.memberId !== undefined && !(await members.isActive(workspaceId, subject.memberId)))
      throw new MemberNotFound(subject.memberId)
    if (subject.roleId !== undefined && !(await members.roleIds(workspaceId)).includes(subject.roleId))
      throw new InvalidConnection(`The workspace has no role ${subject.roleId}`)
    const connection = await workspaceConnections.get(workspaceId, connectionId)
    const previous = (await workspaceConnections.accessOf(workspaceId)).find(
      (row) =>
        row.connectionId === connectionId &&
        (subject.roleId === undefined ? row.memberId === subject.memberId : row.roleId === subject.roleId),
    )
    const access = accessOf(connection, input, previous)

    await workspaceConnections.setAccess(workspaceId, connectionId, subject, access)
    await workspaceEvents.record({
      workspaceId,
      type: 'connection.access_changed',
      payload: { connectionId, ...subject, level: access?.level ?? null, toolChanges: access?.toolChanges ?? {} },
    })
  })
  await grantWorkspaceTools(dependencies, workspaceId, subject.memberId && [subject.memberId])
  await releaseLostSignIns(dependencies, workspaceId, { connectionId })
}
