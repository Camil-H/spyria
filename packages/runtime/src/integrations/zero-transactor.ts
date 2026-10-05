import { findRuntimeHostBySecretHash, lockRuntimeHost, setRuntimeHostSecretHash } from '@hq/db/server-writes'
import type { RuntimeHost as RuntimeHostRow } from '@hq/db/zero'
import { zql } from '@hq/db/zero-queries'
import { memberId, runtimeHostId, workspaceId } from '@hq/kernel'
import type { Transaction } from '@rocicorp/zero'
import type { RuntimeTransactor, UnitOfWork } from '../contracts/transactor.ts'
import { HostNotFound } from '../domain/errors.ts'
import type { RuntimeHost } from '../domain/runtime-host.ts'

const hostOf = (row: RuntimeHostRow): RuntimeHost => ({
  ...row,
  workspaceId: workspaceId(row.workspaceId),
  id: runtimeHostId(row.id),
  createdBy: memberId(row.createdBy),
})

export const createZeroTransactor = (tx: Transaction): RuntimeTransactor => {
  const hostOrUndefined = async (workspaceId: string, id: string) => {
    const row = await tx.run(zql.runtimeHosts.where('workspaceId', workspaceId).where('id', id).one())
    return row && hostOf(row)
  }
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
    },
  }
  return { run: (work) => work(unitOfWork) }
}
