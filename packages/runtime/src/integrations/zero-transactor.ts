import type { Transaction } from '@rocicorp/zero'
import {
  deleteWarmRuntime,
  enqueueJob,
  expireRuntimeHostClaims,
  findRuntimeHostBySecretHash,
  findWarmRuntimes,
  insertWarmRuntime,
  lockMembership,
  lockRuntimeHost,
  lockRuntimeHostLoads,
  lockRuntimes,
  lockWarmRuntimes,
  lockWorkspaceHostLoads,
  refreshMachineCounts,
  rememberAgentConversation,
  runtimeChatOfLlmTokenHash,
  serverOnlyRuntimeValueOf,
  setRuntimeHostSecretHash,
  setRuntimesHostOnline,
  setServerOnlyRuntimeValue,
  updateWarmRuntime,
  type WarmRuntimeRow,
} from '@spyria/db/server-writes'
import type { RuntimeHost as RuntimeHostRow, Runtime as RuntimeRow } from '@spyria/db/zero'
import {
  type Transact,
  transactingTransactor,
  transactorOver,
  workspacePermissionsOf,
  type ZeroContext,
  zql,
} from '@spyria/db/zero-queries'
import {
  chatId,
  harnessOf,
  memberId,
  runtimeHostId,
  runtimeId,
  setupCommandOf,
  setupCommandsFrom,
  type WorkspaceId,
  warmPoolsOf,
  workspaceId,
} from '@spyria/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { HostNotFound, RuntimeNotFound } from '../domain/errors.ts'
import type { Runtime } from '../domain/runtime.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'
import type { WarmRuntime } from '../domain/warm-runtime.ts'

export const contextPermissionsOf = (tx: Transaction, context: ZeroContext) =>
  workspacePermissionsOf(tx, context.workspaceId, context.userId)

const hostOf = (row: RuntimeHostRow): RuntimeHost => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  id: runtimeHostId(row.id),
  protocolVersion: row.protocolVersion ?? 0,
  createdBy: memberId(row.createdBy),
  ownerId: row.ownerId ? memberId(row.ownerId) : null,
})

const runtimeOf = (row: RuntimeRow): Runtime => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  id: runtimeId(row.id),
  chatId: chatId(row.chatId),
  hostId: row.hostId === null ? null : runtimeHostId(row.hostId),
  hostOnline: row.hostOnline === true,
})

const warmRuntimeOf = (row: WarmRuntimeRow): WarmRuntime => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  id: runtimeId(row.id),
  hostId: runtimeHostId(row.hostId),
})

export const createZeroTransactor = (tx: Transaction): RuntimeTransactor => {
  const setupCommandsOf = async (workspaceId: string) =>
    setupCommandsFrom((await tx.run(zql.workspaces.where('workspaceId', workspaceId).one()))?.setupCommands)
  const chatOf = (workspaceId: string, id: string) =>
    tx.run(zql.chats.where('workspaceId', workspaceId).where('id', id).one())
  const hostLoadsOf = (loads: { hostId: string; online: boolean; cap: number; running: number }[]) =>
    loads.map((load) => ({ ...load, hostId: runtimeHostId(load.hostId) }))
  const hostOrUndefined = async (workspaceId: string, id: string) => {
    const row = await tx.run(zql.runtimeHosts.where('workspaceId', workspaceId).where('id', id).one())
    return row && hostOf(row)
  }
  const runtimesWithIds = async (workspaceId: WorkspaceId, ids: readonly string[]) =>
    ids.length === 0
      ? []
      : (await tx.run(zql.runtimes.where('workspaceId', workspaceId).where('id', 'IN', ids))).map(runtimeOf)
  const unitOfWork: UnitOfWork = {
    runtimeHosts: {
      add: async (host) => {
        await tx.mutate.runtimeHosts.insert(host)
        if (host.ownerId !== null) await refreshMachineCounts(tx, host.workspaceId)
      },
      get: async (workspaceId, hostId) => {
        await lockRuntimeHost(tx, workspaceId, hostId)
        const host = await hostOrUndefined(workspaceId, hostId)
        if (!host) throw new HostNotFound(hostId)
        return host
      },
      find: hostOrUndefined,
      save: async (host) => {
        await tx.mutate.runtimeHosts.update(host)
        if (host.ownerId !== null) await refreshMachineCounts(tx, host.workspaceId)
      },
      setSecretHash: async (host, secret, hash) => {
        await setRuntimeHostSecretHash(tx, host, secret, hash)
      },
      findBySecretHash: async (secret, hash) => {
        const located = await findRuntimeHostBySecretHash(tx, secret, hash)
        if (!located) return undefined
        const host = await hostOrUndefined(located.workspaceId, located.id)
        return host && { host, claimed: located.claimed }
      },
      lockLoads: async (workspaceId, chatId) => hostLoadsOf(await lockRuntimeHostLoads(tx, workspaceId, chatId)),
      lockWorkspaceLoads: async (workspaceId) => hostLoadsOf(await lockWorkspaceHostLoads(tx, workspaceId)),
      listMachines: async (workspaceId) =>
        (
          await tx.run(
            zql.runtimeHosts
              .where('workspaceId', workspaceId)
              .where('ownerId', 'IS NOT', null)
              .where('removedAt', 'IS', null),
          )
        ).map(hostOf),
      listOnline: async (workspaceId) =>
        (
          await tx.run(
            zql.runtimeHosts.where('workspaceId', workspaceId).where('status', 'online').where('removedAt', 'IS', null),
          )
        ).map(hostOf),
      expireClaims: async (workspaceId, now) => {
        await expireRuntimeHostClaims(tx, workspaceId, now)
      },
    },
    runtimes: {
      lock: async (workspaceId, id) => {
        const [runtime] = await runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'id', id))
        if (!runtime) throw new RuntimeNotFound(id)
        return runtime
      },
      lockByChat: async (workspaceId, chatId) =>
        (await runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'chat', chatId)))[0],
      lockOnHost: async (workspaceId, hostId) =>
        runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'host', hostId)),
      lockWaitingOnHost: async (workspaceId, hostId) =>
        runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'waitingOnHost', hostId)),
      lockIdle: async (workspaceId, { stopBefore, removeBefore }) =>
        runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'idle', stopBefore, removeBefore)),
      findByIds: runtimesWithIds,
      findByChat: async (workspaceId, chatId) => {
        const row = await tx.run(zql.runtimes.where('workspaceId', workspaceId).where('chatId', chatId).one())
        return row && runtimeOf(row)
      },
      launchOptionsOf: async (runtime) => {
        const chat = await chatOf(runtime.workspaceId, runtime.chatId)
        const ownerId = chat?.ownerUserId ?? chat?.ownerServiceIdentityId
        const setupCommand =
          chat?.repository && !chat.localSession
            ? setupCommandOf(await setupCommandsOf(runtime.workspaceId), chat.repository)
            : null
        return {
          harness: chat?.localSession ? harnessOf(chat.harness) : undefined,
          packageCache: chat?.repository && ownerId ? { repository: chat.repository, ownerId } : undefined,
          setupSnapshot: chat?.repository && setupCommand ? { repository: chat.repository, setupCommand } : undefined,
        }
      },
      claimScopeOf: async (workspaceId, chatId) => {
        const chat = await chatOf(workspaceId, chatId)
        if (!chat?.repository || !chat.baseBranch || chat.localSession) return undefined
        const setupCommand = setupCommandOf(await setupCommandsOf(workspaceId), chat.repository)
        return setupCommand ? { repository: chat.repository, baseBranch: chat.baseBranch, setupCommand } : undefined
      },
      add: (runtime) => tx.mutate.runtimes.insert(runtime),
      save: (runtime) => tx.mutate.runtimes.update(runtime),
      delete: (runtime) => tx.mutate.runtimes.delete(runtime),
      setHostOnline: async (workspaceId, hostId, isOnline) => {
        await setRuntimesHostOnline(tx, workspaceId, hostId, isOnline)
      },
      agentConversationOf: (runtime) =>
        serverOnlyRuntimeValueOf(tx, runtime.workspaceId, runtime.id, 'agentConversation'),
      rememberAgentConversation: (runtime, conversationId) =>
        rememberAgentConversation(tx, runtime.workspaceId, runtime.id, conversationId),
      forgetAgentConversation: async (runtime) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, 'agentConversation', null)
      },
      workspaceSnapshotOf: (runtime) =>
        serverOnlyRuntimeValueOf(tx, runtime.workspaceId, runtime.id, 'workspaceSnapshot'),
      keepWorkspaceSnapshot: async (runtime, snapshot) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, 'workspaceSnapshot', snapshot)
      },
      apiKeyIdOf: (runtime) => serverOnlyRuntimeValueOf(tx, runtime.workspaceId, runtime.id, 'apiKeyId'),
      keepApiKeyId: async (runtime, apiKeyId) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, 'apiKeyId', apiKeyId)
      },
      chatOfLlmTokenHash: async (workspaceId, hostId, hash) => {
        const id = await runtimeChatOfLlmTokenHash(tx, workspaceId, hostId, hash)
        return id === undefined ? undefined : chatId(id)
      },
    },
    warmRuntimes: {
      lockAll: async (workspaceId) => (await lockWarmRuntimes(tx, workspaceId, 'all')).map(warmRuntimeOf),
      lock: async (workspaceId, id) => {
        const [row] = await lockWarmRuntimes(tx, workspaceId, 'id', id)
        return row && warmRuntimeOf(row)
      },
      lockClaimable: async (workspaceId, { repository, baseBranch, setupCommand }, image) => {
        const [row] = await lockWarmRuntimes(tx, workspaceId, 'claimable', repository, baseBranch, setupCommand, image)
        return row && warmRuntimeOf(row)
      },
      lockOnHost: async (workspaceId, hostId) =>
        (await lockWarmRuntimes(tx, workspaceId, 'host', hostId)).map(warmRuntimeOf),
      findByIds: async (workspaceId, ids) =>
        ids.length === 0 ? [] : (await findWarmRuntimes(tx, workspaceId, ids)).map(warmRuntimeOf),
      add: async (warm) => {
        await insertWarmRuntime(tx, warm)
      },
      save: async (warm) => {
        await updateWarmRuntime(tx, warm)
      },
      delete: async (warm) => {
        await deleteWarmRuntime(tx, warm.workspaceId, warm.id)
      },
    },
    secrets: {
      keepLlmTokenHash: async (runtime, hash) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, 'llmTokenHash', hash)
      },
      discard: async (runtime) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, 'llmTokenHash', null)
      },
    },
    jobs: {
      enqueue: async (workspaceId, type, payload, delayMilliseconds = 0) => {
        await enqueueJob(tx, { workspaceId, type, payload, delayMilliseconds })
      },
    },
    workspaces: {
      lockMember: async (workspaceId, memberId) => {
        await lockMembership(tx, workspaceId, memberId)
      },
      localSessionsOf: async (workspaceId) =>
        (await tx.run(zql.workspaces.where('workspaceId', workspaceId).one()))?.localSessions ?? true,
      setLocalSessions: (workspaceId, isOn) => tx.mutate.workspaces.update({ workspaceId, localSessions: isOn }),
      warmPoolsOf: async (workspaceId) => warmPoolsOf(await setupCommandsOf(workspaceId)),
    },
  }
  return transactorOver(tx, unitOfWork)
}

export const createTransactingZeroTransactor = (transact: Transact): RuntimeTransactor =>
  transactingTransactor(transact, createZeroTransactor)
