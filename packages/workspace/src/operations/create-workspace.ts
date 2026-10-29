import { type MemberId, workspaceId } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import type { Name } from '../domain/name.ts'
import { founderMembership } from '../domain/workspace.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; ownerId: MemberId; name: Name }

export const createWorkspace = ({ transactor }: Dependencies, { id, ownerId, name }: Input) =>
  transactor.run(async (unitOfWork) => {
    await unitOfWork.workspaces.add({ id: workspaceId(id), name })
    await unitOfWork.memberships.add(founderMembership(workspaceId(id), ownerId))
  })
