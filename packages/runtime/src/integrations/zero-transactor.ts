import {
  enqueueJob,
  findRuntimeHostBySecretHash,
  lockRuntimeHost,
  lockRuntimeHostLoads,
  lockRuntimes,
  rememberAgentConversation,
  runtimeChatOfLlmTokenHash,
  serverOnlyRuntimeValueOf,
  setRuntimeHostSecretHash,
  setRuntimesHostOnline,
  setServerOnlyRuntimeValue,
} from '@hq/db/server-writes'
import type { RuntimeHost as RuntimeHostRow, Runtime as RuntimeRow } from '@hq/db/zero'
import { zql } from '@hq/db/zero-queries'
import { chatId, memberId, runtimeHostId, runtimeId, type WorkspaceId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { HostNotFound, RuntimeNotFound } from '../domain/errors.ts'
import type { Runtime } from '../domain/runtime.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'

export type Transact = <Result>(work: (tx: Transaction) => Promise<Result>) => Promise<Result>

const hostOf = (row: RuntimeHostRow): RuntimeHost => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  id: runtimeHostId(row.id),
  createdBy: memberId(row.createdBy),
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
      add: (host) => tx.mutate.runtimeHosts.insert(host),
      get: async (workspaceId, hostId) => {
        await lockRuntimeHost(tx, workspaceId, hostId)
        const host = await hostOrUndefined(workspaceId, hostId)
        if (!host) throw new HostNotFound(hostId)
        return host
      },
      save: (host) => tx.mutate.runtimeHosts.update(host),
      setSecretHash: async (host, secret, hash) => {
        await setRuntimeHostSecretHash(tx, host, secret, hash)
      },
      findBySecretHash: async (secret, hash) => {
        const located = await findRuntimeHostBySecretHash(tx, secret, hash)
        if (!located) return undefined
        const host = await hostOrUndefined(located.workspaceId, located.id)
        return host && { host, claimed: located.claimed }
      },
      lockLoads: async (workspaceId) =>
        (await lockRuntimeHostLoads(tx, workspaceId)).map((load) => ({ ...load, hostId: runtimeHostId(load.hostId) })),
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
      lockSweepable: async (workspaceId) =>
        runtimesWithIds(workspaceId, await lockRuntimes(tx, workspaceId, 'sweepable')),
      findByChat: async (workspaceId, chatId) => {
        const row = await tx.run(zql.runtimes.where('workspaceId', workspaceId).where('chatId', chatId).one())
        return row && runtimeOf(row)
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
      chatOfLlmTokenHash: async (workspaceId, hostId, hash) => {
        const id = await runtimeChatOfLlmTokenHash(tx, workspaceId, hostId, hash)
        return id === undefined ? undefined : chatId(id)
      },
    },
    secrets: {
      keep: async (runtime, secret, value) => {
        await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, secret, value)
      },
      valueOf: (runtime, secret) => serverOnlyRuntimeValueOf(tx, runtime.workspaceId, runtime.id, secret),
      discard: async (runtime) => {
        for (const secret of ['apiKey', 'llmTokenHash'] as const)
          await setServerOnlyRuntimeValue(tx, runtime.workspaceId, runtime.id, secret, null)
      },
    },
    jobs: {
      enqueue: async (workspaceId, type, payload, delayMilliseconds = 0) => {
        await enqueueJob(tx, { workspaceId, type, payload, delayMilliseconds })
      },
    },
  }
  return { run: (work) => work(unitOfWork) }
}

export const createTransactingZeroTransactor = (transact: Transact): RuntimeTransactor => ({
  run: (work) => transact((tx) => createZeroTransactor(tx).run(work)),
})
