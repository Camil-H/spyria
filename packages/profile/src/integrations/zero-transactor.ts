import type { Transaction } from '@rocicorp/zero'
import {
  appendWorkspaceEvent,
  deleteGitHubConnection,
  enqueueJob,
  gatewayKeyRefOf,
  gatewayKeyRefsOf,
  insertLlmCredential,
  lockMembership,
  setVirtualKeyId,
  virtualKeyIdOf,
  virtualKeyIdsIn,
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
  gatewayKeyOf,
  type MemberId,
  MemberNotFound,
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
      removeToolServerLater: async ({ workspaceId: workspace, gatewayName }) => {
        await enqueueJob(tx, {
          workspaceId: inContextWorkspace(workspace),
          type: profileJobTypes.toolServerRemoval,
          payload: { gatewayName },
          delayMilliseconds: 0,
        })
      },
    },
    personalConnections: {
      connect: async ({ tool, status }) => {
        await lockMembership(tx, workspaceId, userId)
        const stored = await tx.run(ownToolConnections)
        if (stored.some((row) => row.tool === tool)) await tx.mutate.toolConnections.update({ ...owner, tool, status })
        else {
          const position = Math.max(0, ...stored.map((row) => row.position)) + 1
          await tx.mutate.toolConnections.insert({ ...owner, tool, status, position })
        }
      },
      disconnect: (tool) => tx.mutate.toolConnections.delete({ ...owner, tool }),
      removeAll: async () => {
        for (const { tool } of await tx.run(ownToolConnections))
          await tx.mutate.toolConnections.delete({ ...owner, tool })
        await deleteGitHubConnection(tx, workspaceId, userId)
      },
      statusOf: async (tool) => (await tx.run(ownToolConnections.where('tool', tool).one()))?.status,
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
      add: (connection) => tx.mutate.workspaceConnections.insert(connection),
      save: (connection) => tx.mutate.workspaceConnections.update(connection),
      remove: async (workspaceId, connectionId) => {
        for (const { userId } of await tx.run(
          zql.connectionRestrictions.where('workspaceId', workspaceId).where('connectionId', connectionId),
        ))
          await tx.mutate.connectionRestrictions.delete({ workspaceId, connectionId, userId })
        await tx.mutate.workspaceConnections.delete({ workspaceId: inContextWorkspace(workspaceId), id: connectionId })
      },
      restrictionsOf: async (workspaceId) =>
        (await tx.run(zql.connectionRestrictions.where('workspaceId', inContextWorkspace(workspaceId)))).map(
          ({ connectionId, userId, allowedTools }) => ({ connectionId, memberId: toMemberId(userId), allowedTools }),
        ),
      restrict: (workspaceId, { connectionId, memberId, allowedTools }) =>
        tx.mutate.connectionRestrictions.upsert({
          workspaceId: inContextWorkspace(workspaceId),
          connectionId,
          userId: memberId,
          allowedTools,
        }),
      unrestrict: (workspaceId, connectionId, memberId) =>
        tx.mutate.connectionRestrictions.delete({
          workspaceId: inContextWorkspace(workspaceId),
          connectionId,
          userId: memberId,
        }),
      removeRestrictionsOf: async (workspaceId, memberId) => {
        for (const { connectionId } of await tx.run(
          zql.connectionRestrictions.where('workspaceId', inContextWorkspace(workspaceId)).where('userId', memberId),
        ))
          await tx.mutate.connectionRestrictions.delete({ workspaceId, connectionId, userId: memberId })
      },
    },
    workspaceEvents: {
      record: async ({ workspaceId: workspace, ...event }) => {
        await appendWorkspaceEvent(tx, { ...event, workspaceId: inContextWorkspace(workspace), actorId: userId })
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
