import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { RuntimeTransactor } from '../contracts/transactor.ts'
import { retireHost } from './remove-runtime-host.ts'

type Dependencies = { transactor: RuntimeTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; now: number }

export const removeMemberMachine = ({ transactor }: Dependencies, { workspaceId, memberId, now }: Input) =>
  transactor.run(async (unitOfWork) => {
    const machine = (await unitOfWork.runtimeHosts.listMachines(workspaceId)).find((host) => host.ownerId === memberId)
    if (machine) await retireHost(unitOfWork, machine, now)
    return machine?.id
  })
