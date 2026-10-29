import type { Transaction } from '@rocicorp/zero'
import {
  enqueueJob,
  expireRuntimeHostClaims,
  findRuntimeHostBySecretHash,
  lockMembership,
  lockRuntimeHost,
  lockRuntimeHostLoads,
  lockRuntimes,
  refreshMachineCounts,
  rememberAgentConversation,
  runtimeChatOfLlmTokenHash,
  serverOnlyRuntimeValueOf,
  setRuntimeHostSecretHash,
  setRuntimesHostOnline,
  setServerOnlyRuntimeValue,
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
import { chatId, harnessOf, memberId, runtimeHostId, runtimeId, type WorkspaceId, workspaceId } from '@spyria/kernel'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { HostNotFound, RuntimeNotFound } from '../domain/errors.ts'
import type { Runtime } from '../domain/runtime.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'

export const contextPermissionsOf = (tx: Transaction, context: ZeroContext) =>
  workspacePermissionsOf(tx, context.workspaceId, context.userId)

const hostOf = (row: RuntimeHostRow): RuntimeHost => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  id: runtimeHostId(row.id),
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

export const createZeroTransactor = (tx: Transaction): RuntimeTransactor => {
  const hostOrUndefined = async (workspaceId: string, id: string) => {
    const row = await tx.run(zql.runtimeHosts.where('workspaceId', workspaceId).where('id', id).one())
    return row && hostOf(row)
  }
  const runtimesWithIds = async (workspaceId: WorkspaceId, ids: string[]) =>
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
      lockLoads: async (workspaceId, chatId) =>
        (await lockRuntimeHostLoads(tx, workspaceId, chatId)).map((load) => ({
          ...load,
          hostId: runtimeHostId(load.hostId),
        })),
      listMachines: async (workspaceId) =>
        (
          await tx.run(
            zql.runtimeHosts
              .where('workspaceId', workspaceId)
              .where('ownerId', 'IS NOT', null)
              .where('removedAt', 'IS', null),
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
      lockSweepable: async (workspaceId) =>
        runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'sweepable')),
      findByChat: async (workspaceId, chatId) => {
        const row = await tx.run(zql.runtimes.where('workspaceId', workspaceId).where('chatId', chatId).one())
        return row && runtimeOf(row)
      },
      localHarnessOf: async (runtime) => {
        const chat = await tx.run(zql.chats.where('workspaceId', runtime.workspaceId).where('id', runtime.chatId).one())
        return chat?.localSession ? harnessOf(chat.harness) : undefined
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
      chatOfLlmTokenHash: async (workspaceId, hostId, hash) => {
        const id = await runtimeChatOfLlmTokenHash(tx, workspaceId, hostId, hash)
        return id === undefined ? undefined : chatId(id)
      },
    },
    secrets: {
      keep: async (runtime, secret, value) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, secret, value)
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
    },
  }
  return transactorOver(tx, unitOfWork)
}

export const createTransactingZeroTransactor = (transact: Transact): RuntimeTransactor =>
  transactingTransactor(transact, createZeroTransactor)
