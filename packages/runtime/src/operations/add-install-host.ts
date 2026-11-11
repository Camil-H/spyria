import { type MemberId, runtimeHostId, type WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { hashSecret, installHostClaimLifetimeMilliseconds } from '../domain/claim.ts'
import { HostName } from '../domain/host-name.ts'
import { waitingHostOf } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { id: string; workspaceId: WorkspaceId; memberId: MemberId; installHostToken: string; now: number }

const installHostName = 'This machine'

export const addInstallHost = async (
  { transactor }: Dependencies,
  { id, workspaceId, memberId, installHostToken, now }: Input,
) => {
  const host = waitingHostOf({
    workspaceId,
    id: runtimeHostId(id),
    name: HostName(installHostName),
    claimExpiresAt: now + installHostClaimLifetimeMilliseconds,
    createdBy: memberId,
    ownerId: null,
    createdAt: now,
  })
  const claimCodeHash = await hashSecret(installHostToken)
  await transactor.run(async ({ runtimeHosts }) => {
    await runtimeHosts.add(host)
    await runtimeHosts.setSecretHash(host, 'claimCode', claimCodeHash)
  })
}
