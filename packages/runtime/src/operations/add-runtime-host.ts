import { type MemberId, runtimeHostId, type WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { claimLifetimeMilliseconds, hashSecret, newClaimCode } from '../domain/claim.ts'
import { HostName } from '../domain/host-name.ts'
import { assertAdmin } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  id: string
  workspaceId: WorkspaceId
  memberId: MemberId
  role: 'admin' | 'member'
  name: string
  now: number
}

export const addRuntimeHost = async (
  { transactor }: Dependencies,
  { id, memberId, role, name, now, ...input }: Input,
) => {
  assertAdmin(role)
  const host = {
    ...input,
    id: runtimeHostId(id),
    name: HostName(name),
    status: 'waiting' as const,
    claimExpiresAt: now + claimLifetimeMilliseconds,
    capacity: null,
    runningRuntimes: 0,
    lastSeenAt: null,
    createdBy: memberId,
    createdAt: now,
    removedAt: null,
  }
  const code = newClaimCode()
  const claimCodeHash = await hashSecret(code)
  await transactor.run(async ({ runtimeHosts }) => {
    await runtimeHosts.add(host)
    await runtimeHosts.setSecretHash(host, 'claimCode', claimCodeHash)
  })
  return { id: host.id, code }
}
