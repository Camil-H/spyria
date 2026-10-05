import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { claimRefusal, hashSecret, newSecretToken } from '../domain/claim.ts'
import { CodeExpired, CodeNotValid } from '../domain/errors.ts'

type Dependencies = { transactor: RuntimeTransactor }

export const claimRuntimeHost = async ({ transactor }: Dependencies, { code, now }: { code: string; now: number }) => {
  const token = newSecretToken()
  const [claimCodeHash, tokenHash] = await Promise.all([hashSecret(code), hashSecret(token)])
  return transactor.run(async ({ runtimeHosts }) => {
    const found = await runtimeHosts.findBySecretHash('claimCode', claimCodeHash)
    if (!found) return { refusal: new CodeNotValid() }
    const { host, claimed } = found
    const refusal = claimRefusal({ ...host, claimed }, now)
    if (refusal instanceof CodeExpired && host.status === 'waiting')
      await runtimeHosts.save({ ...host, status: 'expired' })
    if (refusal) return { refusal }
    await runtimeHosts.save({ ...host, status: 'offline' })
    await runtimeHosts.setSecretHash(host, 'token', tokenHash)
    return { workspaceId: host.workspaceId, hostId: host.id, token }
  })
}
