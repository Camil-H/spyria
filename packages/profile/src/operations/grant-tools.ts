import { grantedToolsOf, log, type MemberId, type WorkspaceId } from '@spyria/kernel'
import type { ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { connectionSignIns } from '../domain/workspace-connection.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: ToolGateway }
type Member = { workspaceId: WorkspaceId; memberId: MemberId }

export const inMemberOrderOf = () => {
  const workByMember = new Map<string, Promise<unknown>>()
  return <Result>({ workspaceId, memberId }: Member, work: () => Promise<Result>) => {
    const memberKey = `${workspaceId}/${memberId}`
    const result = (workByMember.get(memberKey) ?? Promise.resolve()).then(work, work)
    const settled = result.catch(() => {})
    workByMember.set(memberKey, settled)
    settled.then(() => workByMember.get(memberKey) === settled && workByMember.delete(memberKey))
    return result
  }
}

const inGrantOrder = inMemberOrderOf()

const virtualKeysOf = ({ transactor }: Pick<Dependencies, 'transactor'>, workspaceId: WorkspaceId) =>
  transactor.run(({ memberGatewayKeys }) => memberGatewayKeys.virtualKeysIn(workspaceId))

const grantToolsOn = (
  { transactor, gateway }: Dependencies,
  workspaceId: WorkspaceId,
  { memberId, virtualKeyId }: { memberId: MemberId; virtualKeyId: string },
) =>
  inGrantOrder({ workspaceId, memberId }, async () => {
    const { connections, accessRows, holder } = await transactor.run(async ({ workspaceConnections, members }) => ({
      connections: await workspaceConnections.list(workspaceId),
      accessRows: await workspaceConnections.accessOf(workspaceId),
      holder: (await members.holders(workspaceId)).find((candidate) => candidate.memberId === memberId),
    }))
    await gateway.setToolGrants(
      virtualKeyId,
      Object.fromEntries(
        connections.map((connection) => [
          connection.gatewayName,
          holder ? grantedToolsOf(connection, accessRows, holder) : [],
        ]),
      ),
    )
  })

const regrantLater = async (
  { transactor }: Pick<Dependencies, 'transactor'>,
  { workspaceId, memberId }: Member,
  error: unknown,
) => {
  log.error({
    event: 'member_tools.grant_failed',
    body: 'Granting the workspace tools of a member failed; a gateway sync retries it',
    attributes: { 'workspace.id': workspaceId, 'member.id': memberId },
    error,
  })
  await transactor.run(({ gatewayJobs }) => gatewayJobs.regrantLater(memberId))
}

export const grantMemberTools = async (dependencies: Dependencies, { workspaceId, memberId }: Member) => {
  for (const key of await virtualKeysOf(dependencies, workspaceId))
    if (key.memberId === memberId) await grantToolsOn(dependencies, workspaceId, key)
}

export const grantMemberToolsOrRetryLater = (dependencies: Dependencies, member: Member) =>
  grantMemberTools(dependencies, member).catch((error: unknown) => regrantLater(dependencies, member, error))

export const grantWorkspaceTools = async (dependencies: Dependencies, workspaceId: WorkspaceId) => {
  for (const key of await virtualKeysOf(dependencies, workspaceId))
    await grantToolsOn(dependencies, workspaceId, key).catch((error: unknown) =>
      regrantLater(dependencies, { workspaceId, memberId: key.memberId }, error),
    )
}

export const releaseLostSignIns = async (
  { transactor, gateway }: Dependencies,
  workspaceId: WorkspaceId,
  { connectionId, memberIds }: { connectionId?: string; memberIds?: readonly MemberId[] },
) => {
  const { connections, accessRows, holders, virtualKeys, signedIn } = await transactor.run(
    async ({ workspaceConnections, memberGatewayKeys, members }) => ({
      connections: (await workspaceConnections.list(workspaceId)).filter(
        (connection) =>
          connection.signIn === connectionSignIns.member &&
          (connectionId === undefined || connection.id === connectionId),
      ),
      accessRows: await workspaceConnections.accessOf(workspaceId),
      holders: await members.holders(workspaceId),
      virtualKeys: await memberGatewayKeys.virtualKeysIn(workspaceId),
      signedIn: await workspaceConnections.signIns(workspaceId),
    }),
  )
  if (connections.length === 0) return
  const serverByName = new Map((await gateway.toolServers()).map((server) => [server.name, server]))
  const holderById = new Map(holders.map((holder) => [holder.memberId, holder]))
  const accessRowsByConnection = Map.groupBy(accessRows, (access) => access.connectionId)
  const keptMemberIds = memberIds && new Set(memberIds)
  const keysOfMembers = virtualKeys.filter((key) => keptMemberIds?.has(key.memberId) ?? true)
  const losingMemberIds = new Set<MemberId>()
  for (const connection of connections) {
    const server = serverByName.get(connection.gatewayName)
    const accessToConnection = accessRowsByConnection.get(connection.id) ?? []
    for (const { memberId, virtualKeyId } of keysOfMembers) {
      const holder = holderById.get(memberId)
      if (holder && grantedToolsOf(connection, accessToConnection, holder).length > 0) continue
      const sessions = server ? await gateway.toolSessions(virtualKeyId, server) : []
      for (const session of sessions) await gateway.removeToolSession(session.id)
      const isSignedIn = signedIn.some(
        (signIn) => signIn.memberId === memberId && signIn.connectionId === connection.id,
      )
      if (sessions.length > 0 || isSignedIn) losingMemberIds.add(memberId)
    }
  }
  for (const memberId of losingMemberIds)
    await transactor.run(({ gatewayJobs }) => gatewayJobs.syncToolConnectionsLater(memberId))
}
