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
import { type MemberId, MemberNotFound, memberId as toMemberId, type WorkspaceId } from '@spyria/kernel'
import type { ProfileTransactor, UnitOfWork } from '../contracts/transactor.ts'
import type { Avatar } from '../domain/avatar.ts'
import { DisplayName } from '../domain/display-name.ts'
import { ConnectionNotFound, CredentialNotFound, NotOwnProfile } from '../domain/errors.ts'
import { gatewayKeyOf, profileJobTypes, gatewayKeyRefOf as refOf } from '../domain/llm-credential.ts'
import type { WorkspaceConnection } from '../domain/workspace-connection.ts'

export const createZeroTransactor = (tx: Transaction, context: ZeroContext): ProfileTransactor => {
  const asContextMember = (workspaceId: WorkspaceId, memberId: MemberId) => {
    if (workspaceId !== context.workspaceId || memberId !== context.userId) throw new NotOwnProfile()
    return { workspaceId, userId: memberId }
  }
  const inContextWorkspace = (workspaceId: WorkspaceId) => {
    if (workspaceId !== context.workspaceId) throw new NotOwnProfile()
    return workspaceId
  }
  const connectionOf = (row: Omit<WorkspaceConnection, 'workspaceId'> & { workspaceId: string }) =>
    ({ ...row, workspaceId: inContextWorkspace(row.workspaceId as WorkspaceId) }) as WorkspaceConnection
  const connectionRows = (workspaceId: WorkspaceId) =>
    zql.workspaceConnections.where('workspaceId', inContextWorkspace(workspaceId))
  const unitOfWork: UnitOfWork = {
    members: {
      get: async (workspaceId, memberId) => {
        asContextMember(workspaceId, memberId)
        const row = await tx.run(zql.memberships.where('workspaceId', workspaceId).where('userId', memberId).one())
        if (!row) throw new MemberNotFound(memberId)
        return {
          workspaceId,
          id: memberId,
          name: DisplayName(row.displayName),
          avatar: (row.avatar ?? null) as Avatar | null,
        }
      },
      save: (member) =>
        tx.mutate.memberships.update({
          ...asContextMember(member.workspaceId, member.id),
          displayName: member.name,
          avatar: member.avatar,
        }),
      permissions: (workspaceId, memberId) => workspacePermissionsOf(tx, inContextWorkspace(workspaceId), memberId),
      isActive: (workspaceId, memberId) => isActiveMember(tx, inContextWorkspace(workspaceId), memberId),
    },
    llmCredentials: {
      add: async ({ workspaceId, memberId, id, provider, last4 }, key) => {
        asContextMember(workspaceId, memberId)
        await insertLlmCredential(tx, { workspaceId, id, userId: memberId, provider, last4, secretRef: refOf(key) })
      },
      remove: async (workspaceId, memberId, id) => {
        asContextMember(workspaceId, memberId)
        const row = await tx.run(
          zql.llmCredentials.where('workspaceId', workspaceId).where('userId', memberId).where('id', id).one(),
        )
        if (!row) throw new CredentialNotFound(id)
        const storedRef = await gatewayKeyRefOf(tx, workspaceId, id)
        await tx.mutate.llmCredentials.delete({ workspaceId, id })
        return storedRef ? gatewayKeyOf(storedRef) : undefined
      },
      removeAll: async (workspaceId, memberId) => {
        const refs = await gatewayKeyRefsOf(tx, workspaceId, memberId)
        for (const row of await tx.run(
          zql.llmCredentials
            .where('workspaceId', asContextMember(workspaceId, memberId).workspaceId)
            .where('userId', memberId),
        ))
          await tx.mutate.llmCredentials.delete({ workspaceId, id: row.id })
        return refs.flatMap((ref) => gatewayKeyOf(ref) ?? [])
      },
      gatewayKeysOf: async (workspaceId, memberId) => {
        asContextMember(workspaceId, memberId)
        return (await gatewayKeyRefsOf(tx, workspaceId, memberId)).flatMap((ref) => gatewayKeyOf(ref) ?? [])
      },
    },
    memberGatewayKeys: {
      virtualKeyOf: (workspaceId, memberId) => virtualKeyIdOf(tx, workspaceId, memberId),
      setVirtualKey: async (workspaceId, memberId, virtualKeyId) => {
        asContextMember(workspaceId, memberId)
        await setVirtualKeyId(tx, workspaceId, memberId, virtualKeyId)
      },
      virtualKeysIn: async (workspaceId) =>
        (await virtualKeyIdsIn(tx, inContextWorkspace(workspaceId))).map((row) => ({
          ...row,
          memberId: toMemberId(row.memberId),
        })),
    },
    gatewayJobs: {
      syncLater: async (job) => {
        await enqueueJob(tx, {
          workspaceId: job.workspaceId,
          type: profileJobTypes.gatewaySync,
          payload: job,
          delayMilliseconds: 0,
        })
      },
      removeToolServerLater: async ({ workspaceId, gatewayName }) => {
        await enqueueJob(tx, {
          workspaceId: inContextWorkspace(workspaceId),
          type: profileJobTypes.toolServerRemoval,
          payload: { gatewayName },
          delayMilliseconds: 0,
        })
      },
    },
    personalConnections: {
      connect: async ({ workspaceId, memberId, tool, status }) => {
        const owner = asContextMember(workspaceId, memberId)
        await lockMembership(tx, workspaceId, memberId)
        const stored = await tx.run(zql.toolConnections.where('workspaceId', workspaceId).where('userId', memberId))
        if (stored.some((row) => row.tool === tool)) await tx.mutate.toolConnections.update({ ...owner, tool, status })
        else {
          const position = Math.max(0, ...stored.map((row) => row.position)) + 1
          await tx.mutate.toolConnections.insert({ ...owner, tool, status, position })
        }
      },
      disconnect: (workspaceId, memberId, tool) =>
        tx.mutate.toolConnections.delete({ ...asContextMember(workspaceId, memberId), tool }),
      removeAll: async (workspaceId, memberId) => {
        const owner = asContextMember(workspaceId, memberId)
        for (const { tool } of await tx.run(
          zql.toolConnections.where('workspaceId', workspaceId).where('userId', memberId),
        ))
          await tx.mutate.toolConnections.delete({ ...owner, tool })
        await deleteGitHubConnection(tx, workspaceId, memberId)
      },
      statusOf: async (workspaceId, memberId, tool) =>
        (
          await tx.run(
            zql.toolConnections
              .where('workspaceId', asContextMember(workspaceId, memberId).workspaceId)
              .where('userId', memberId)
              .where('tool', tool)
              .one(),
          )
        )?.status,
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
      record: async ({ workspaceId, ...event }) => {
        await appendWorkspaceEvent(tx, { ...event, workspaceId: inContextWorkspace(workspaceId) })
      },
    },
  }
  return transactorOver(tx, unitOfWork)
}

export const memberContext = (workspace: WorkspaceId, member: MemberId): ZeroContext => ({
  workspaceId: workspace,
  userId: member,
})

export const createTransactingZeroTransactor = (transact: Transact, context: ZeroContext): ProfileTransactor =>
  transactingTransactor(transact, (tx) => createZeroTransactor(tx, context))
