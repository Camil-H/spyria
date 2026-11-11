import {
  type MemberId,
  requirePermissionIn,
  runtimeHostId,
  type WorkspaceId,
  type WorkspacePermission,
} from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { claimLifetimeMilliseconds, hashSecret, newClaimCode } from '../domain/claim.ts'
import { LocalSessionsOff, MachineAlreadyAdded } from '../domain/errors.ts'
import { HostName } from '../domain/host-name.ts'
import { waitingHostOf } from '../domain/runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = {
  id: string
  workspaceId: WorkspaceId
  memberId: MemberId
  permissions: readonly WorkspacePermission[]
  name: string
  personal: boolean
  now: number
}

const machineName = 'My machine'

export const addRuntimeHost = async (
  { transactor }: Dependencies,
  { id, memberId, permissions, name, personal, now, ...input }: Input,
) => {
  if (!personal) requirePermissionIn(permissions, 'runtimes.manage')
  const host = waitingHostOf({
    workspaceId: input.workspaceId,
    id: runtimeHostId(id),
    name: HostName(personal ? machineName : name),
    claimExpiresAt: now + claimLifetimeMilliseconds,
    createdBy: memberId,
    ownerId: personal ? memberId : null,
    createdAt: now,
  })
  const code = newClaimCode()
  const claimCodeHash = await hashSecret(code)
  await transactor.run(async ({ runtimeHosts, workspaces }) => {
    if (personal && !(await workspaces.localSessionsOf(input.workspaceId))) throw new LocalSessionsOff()
    if (personal) await workspaces.lockMember(input.workspaceId, memberId)
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
