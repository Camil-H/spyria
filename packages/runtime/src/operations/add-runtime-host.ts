import { type MemberId, runtimeHostId, type WorkspaceId } from '@hq/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { claimLifetimeMilliseconds, hashSecret, newClaimCode } from '../domain/claim.ts'
import { MachineAlreadyAdded } from '../domain/errors.ts'
import { HostName } from '../domain/host-name.ts'
import { assertAdmin } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  id: string
  workspaceId: WorkspaceId
  memberId: MemberId
  role: 'admin' | 'member'
  name: string
  personal: boolean
  now: number
}

const machineName = 'My machine'

export const addRuntimeHost = async (
  { transactor }: Dependencies,
  { id, memberId, role, name, personal, now, ...input }: Input,
) => {
  if (!personal) assertAdmin(role)
  const host = {
    ...input,
    id: runtimeHostId(id),
    name: HostName(personal ? machineName : name),
    status: 'waiting' as const,
    claimExpiresAt: now + claimLifetimeMilliseconds,
    capacity: null,
    runningRuntimes: 0,
    lastSeenAt: null,
    createdBy: memberId,
    ownerId: personal ? memberId : null,
    createdAt: now,
    removedAt: null,
  }
  const code = newClaimCode()
  const claimCodeHash = await hashSecret(code)
  await transactor.run(async ({ runtimeHosts }) => {
    if (
      personal &&
      (await runtimeHosts.listMachines(input.workspaceId)).some((machine) => machine.ownerId === memberId)
    )
      throw new MachineAlreadyAdded()
    await runtimeHosts.add(host)
    await runtimeHosts.setSecretHash(host, 'claimCode', claimCodeHash)
  })
  return { id: host.id, code }
}
