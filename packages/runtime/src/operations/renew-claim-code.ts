import type { MemberId, RuntimeHostId, WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { claimLifetimeMilliseconds, hashSecret, newClaimCode } from '../domain/claim.ts'
import { CodeNotRenewable } from '../domain/errors.ts'
import { assertCanManage, assertNotRemoved, canRenewClaim } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  workspaceId: WorkspaceId
  memberId: MemberId
  role: 'admin' | 'member'
  hostId: RuntimeHostId
  now: number
}

export const renewClaimCode = async (
  { transactor }: Dependencies,
  { workspaceId, memberId, role, hostId, now }: Input,
) => {
  const code = newClaimCode()
  const claimCodeHash = await hashSecret(code)
  await transactor.run(async ({ runtimeHosts }) => {
    const host = assertCanManage(assertNotRemoved(await runtimeHosts.get(workspaceId, hostId)), memberId, role)
    if (!canRenewClaim(host)) throw new CodeNotRenewable()
    await runtimeHosts.save({ ...host, status: 'waiting', claimExpiresAt: now + claimLifetimeMilliseconds })
    await runtimeHosts.setSecretHash(host, 'claimCode', claimCodeHash)
  })
  return { code }
}
