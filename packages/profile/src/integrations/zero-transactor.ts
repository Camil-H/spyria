import type { Transaction } from '@rocicorp/zero'
import {
  appendWorkspaceEvent,
  deleteGitHubConnection,
  enqueueJob,
  gatewayKeyRefOf,
  gatewayKeyRefsOf,
  insertLlmCredential,
  lockMembership,
  reserveVirtualKeyName,
  setVirtualKeyId,
  virtualKeyIdOf,
  virtualKeyIdsIn,
  virtualKeyNameOf,
} from '@spyria/db/server-writes'
import {
  isActiveMember,
  type Transact,
  transactingTransactor,
  transactorOver,
  workspacePermissionsOf,
  type ZeroContext,
  zql,
} from '@spyria/db/zero-queries'
import {
  aiProviderAllowListFrom,
  gatewayKeyOf,
  type MemberId,
  MemberNotFound,
  memberActor,
  gatewayKeyRefOf as refOf,
  memberId as toMemberId,
  type WorkspaceId,
} from '@spyria/kernel'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import type { Avatar } from '../domain/avatar.ts'
import { DisplayName } from '../domain/display-name.ts'
import { ConnectionNotFound, CredentialNotFound, NotOwnProfile } from '../domain/errors.ts'
import { profileJobTypes } from '../domain/llm-credential.ts'
import type { WorkspaceConnection } from '../domain/workspace-connection.ts'

export const createZeroTransactor = (tx: Transaction, context: ZeroContext): ProfileTransactor => {
  const { workspaceId, userId } = context
  const member = { workspaceId, memberId: userId }
  const owner = { workspaceId, userId }
  const inContextWorkspace = (id: WorkspaceId) => {
    if (id !== workspaceId) throw new NotOwnProfile()
    return id
  }
  const requireContextMember = (workspace: WorkspaceId, id: MemberId) => {
    if (workspace !== workspaceId || id !== userId) throw new NotOwnProfile()
  }
  const connectionOf = (row: Omit<WorkspaceConnection, 'workspaceId'> & { workspaceId: string }) =>
    ({ ...row, workspaceId: inContextWorkspace(row.workspaceId as WorkspaceId) }) as WorkspaceConnection
  const connectionRows = (id: WorkspaceId) => zql.workspaceConnections.where('workspaceId', inContextWorkspace(id))
  const ownToolConnections = zql.toolConnections.where('workspaceId', workspaceId).where('userId', userId)
  const ownToolApprovals = zql.toolApprovals.where('workspaceId', workspaceId).where('userId', userId)
  const gatewayKeys = async () =>
    (await gatewayKeyRefsOf(tx, workspaceId, userId)).flatMap((ref) => gatewayKeyOf(ref) ?? [])
  const unitOfWork: UnitOfWork = {
    members: {
      get: async () => {
        const row = await tx.run(zql.memberships.where('workspaceId', workspaceId).where('userId', userId).one())
        if (!row) throw new MemberNotFound(userId)
        return {
          workspaceId,
          id: userId,
          name: DisplayName(row.displayName),
          avatar: (row.avatar ?? null) as Avatar | null,
        }
      },
      save: async (changed) => {
        requireContextMember(changed.workspaceId, changed.id)
        await tx.mutate.memberships.update({ ...owner, displayName: changed.name, avatar: changed.avatar })
      },
      permissions: () => workspacePermissionsOf(tx, workspaceId, userId),
      isActive: (workspace, id) => isActiveMember(tx, inContextWorkspace(workspace), id),
      lockActive: async () => {
        await lockMembership(tx, workspaceId, userId)
        if (!(await isActiveMember(tx, workspaceId, userId))) throw new MemberNotFound(userId)
      },
      holders: async (workspace) =>
        (
          await tx.run(
            zql.memberships.where('workspaceId', inContextWorkspace(workspace)).where('removedAt', 'IS', null),
          )
        ).map(({ userId: id, role }) => ({ memberId: toMemberId(id), roleId: role })),
      roleIds: async (workspace) =>
        (await tx.run(zql.workspaceRoles.where('workspaceId', inContextWorkspace(workspace)))).map(({ id }) => id),
    },
    aiProviders: {
      allowList: async () =>
        aiProviderAllowListFrom(
          (await tx.run(zql.workspaces.where('workspaceId', workspaceId).one()))?.aiProviderAllowList,
        ),
      setAllowList: (aiProviderAllowList) => tx.mutate.workspaces.update({ workspaceId, aiProviderAllowList }),
    },
    llmCredentials: {
      add: async ({ id, provider, last4 }, key) => {
        await insertLlmCredential(tx, { workspaceId, id, userId, provider, last4, secretRef: refOf(key) })
      },
      remove: async (id) => {
        const row = await tx.run(
          zql.llmCredentials.where('workspaceId', workspaceId).where('userId', userId).where('id', id).one(),
        )
        if (!row) throw new CredentialNotFound(id)
        const storedRef = await gatewayKeyRefOf(tx, workspaceId, id)
        await tx.mutate.llmCredentials.delete({ workspaceId, id })
        return storedRef ? gatewayKeyOf(storedRef) : undefined
      },
      removeAll: async () => {
        const keys = await gatewayKeys()
        for (const row of await tx.run(zql.llmCredentials.where('workspaceId', workspaceId).where('userId', userId)))
          await tx.mutate.llmCredentials.delete({ workspaceId, id: row.id })
        return keys
      },
      gatewayKeys,
    },
    memberGatewayKeys: {
      virtualKey: () => virtualKeyIdOf(tx, workspaceId, userId),
      virtualKeyName: () => virtualKeyNameOf(tx, workspaceId, userId),
      reserveVirtualKeyName: async () => String(await reserveVirtualKeyName(tx, workspaceId, userId)),
      setVirtualKey: async (virtualKeyId) => {
        await setVirtualKeyId(tx, workspaceId, userId, virtualKeyId)
      },
      virtualKeysIn: async (workspace) =>
        (await virtualKeyIdsIn(tx, inContextWorkspace(workspace))).map((row) => ({
          ...row,
          memberId: toMemberId(row.memberId),
        })),
    },
    gatewayJobs: {
      syncLater: async (job) => {
        await enqueueJob(tx, {
          workspaceId,
          type: profileJobTypes.gatewaySync,
          payload: { ...job, workspaceId, memberId: userId },
          delayMilliseconds: 0,
        })
      },
      regrantLater: async (memberId) => {
        await enqueueJob(tx, {
          workspaceId,
          type: profileJobTypes.gatewaySync,
          payload: { workspaceId, memberId },
          delayMilliseconds: 0,
        })
      },
      removeToolServerLater: async ({ workspaceId: workspace, gatewayName }) => {
        await enqueueJob(tx, {
          workspaceId: inContextWorkspace(workspace),
          type: profileJobTypes.toolServerRemoval,
          payload: { gatewayName },
          delayMilliseconds: 0,
        })
      },
    },
    toolConnections: {
      connect: async ({ connectionId, status }) => {
        await lockMembership(tx, workspaceId, userId)
        await tx.mutate.toolConnections.upsert({ ...owner, connectionId, status })
      },
      disconnect: (connectionId) => tx.mutate.toolConnections.delete({ ...owner, connectionId }),
      removeAll: async () => {
        for (const { connectionId } of await tx.run(ownToolConnections))
          await tx.mutate.toolConnections.delete({ ...owner, connectionId })
        await deleteGitHubConnection(tx, workspaceId, userId)
      },
      statusOf: async (connectionId) =>
        (await tx.run(ownToolConnections.where('connectionId', connectionId).one()))?.status,
      connectionIds: async () => (await tx.run(ownToolConnections)).map(({ connectionId }) => connectionId),
    },
    workspaceConnections: {
      list: async (workspaceId) => (await tx.run(connectionRows(workspaceId))).map(connectionOf),
      get: async (workspaceId, connectionId) => {
        const row = await tx.run(connectionRows(workspaceId).where('id', connectionId).one())
        if (!row) throw new ConnectionNotFound(connectionId)
        return connectionOf(row)
      },
      findByGatewayName: async (workspaceId, gatewayName) => {
        const row = await tx.run(connectionRows(workspaceId).where('gatewayName', gatewayName).one())
        return row && connectionOf(row)
      },
      findByName: async (workspaceId, name) => {
        const row = await tx.run(connectionRows(workspaceId).where('name', name).one())
        return row && connectionOf(row)
      },
      add: (connection) => tx.mutate.workspaceConnections.insert(connection),
      save: (connection) => tx.mutate.workspaceConnections.update(connection),
      remove: async (workspaceId, connectionId) => {
        for (const { userId } of await tx.run(
          zql.toolConnections.where('workspaceId', workspaceId).where('connectionId', connectionId),
        ))
          await tx.mutate.toolConnections.delete({ workspaceId, userId, connectionId })
        for (const { roleId } of await tx.run(
          zql.connectionAccess.where('workspaceId', workspaceId).where('connectionId', connectionId),
        ))
          await tx.mutate.connectionAccess.delete({ workspaceId, connectionId, roleId })
        for (const { userId } of await tx.run(
          zql.toolApprovals.where('workspaceId', workspaceId).where('connectionId', connectionId),
        ))
          await tx.mutate.toolApprovals.delete({ workspaceId, userId, connectionId })
        await tx.mutate.workspaceConnections.delete({ workspaceId: inContextWorkspace(workspaceId), id: connectionId })
      },
      accessOf: async (workspaceId) =>
        (await tx.run(zql.connectionAccess.where('workspaceId', inContextWorkspace(workspaceId)))).map(
          ({ connectionId, roleId, level, toolChanges }) => ({ connectionId, roleId, level, toolChanges }),
        ),
      setAccess: async (workspaceId, connectionId, roleId, access) => {
        const key = { workspaceId: inContextWorkspace(workspaceId), connectionId, roleId }
        if (!access) return tx.mutate.connectionAccess.delete(key)
        await tx.mutate.connectionAccess.upsert({ ...key, level: access.level, toolChanges: access.toolChanges })
      },
      removeSignIn: (workspaceId, connectionId, memberId) =>
        tx.mutate.toolConnections.delete({
          workspaceId: inContextWorkspace(workspaceId),
          userId: memberId,
          connectionId,
        }),
    },
    toolApprovals: {
      get: async (connectionId) => {
        const row = await tx.run(ownToolApprovals.where('connectionId', connectionId).one())
        return row && { connectionId, serverApproval: row.serverApproval, toolApprovals: row.toolApprovals }
      },
      ofMember: async (approver, connectionId) => {
        const row = await tx.run(
          zql.toolApprovals
            .where('workspaceId', workspaceId)
            .where('userId', approver)
            .where('connectionId', connectionId)
            .one(),
        )
        return row && { connectionId, serverApproval: row.serverApproval, toolApprovals: row.toolApprovals }
      },
      save: (preference) => tx.mutate.toolApprovals.upsert({ ...owner, ...preference }),
      removeAll: async () => {
        for (const { connectionId } of await tx.run(ownToolApprovals))
          await tx.mutate.toolApprovals.delete({ ...owner, connectionId })
      },
    },
    workspaceEvents: {
      record: async ({ workspaceId: workspace, ...event }) => {
        await appendWorkspaceEvent(tx, {
          ...event,
          workspaceId: inContextWorkspace(workspace),
          actor: memberActor(userId),
        })
      },
    },
  }
  return { ...transactorOver(tx, unitOfWork), member }
}

export const memberContext = (workspace: WorkspaceId, member: MemberId): ZeroContext => ({
  workspaceId: workspace,
  userId: member,
})

export const createTransactingZeroTransactor = (transact: Transact, context: ZeroContext): ProfileTransactor => ({
  ...transactingTransactor(transact, (tx) => createZeroTransactor(tx, context)),
  member: { workspaceId: context.workspaceId, memberId: context.userId },
})
