import { type MemberId, workspaceId } from '@hq/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; ownerId: MemberId; name: Name }

export const createWorkspace = ({ transactor }: Dependencies, { id, ownerId, name }: Input) =>
  transactor.run(async (unitOfWork) => {
    await unitOfWork.workspaces.add({ id: workspaceId(id), name })
    await unitOfWork.memberships.add({ memberId: ownerId, workspaceId: workspaceId(id) })
  })
