import { type MemberId, type SignedInThrough, workspaceId } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import { requireWorkspaceCreation } from '../domain/domain-claim.ts'
import type { Name } from '../domain/name.ts'
import { founderMembership } from '../domain/workspace.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; ownerId: MemberId; name: Name; signedInThrough: SignedInThrough }

export const createWorkspace = ({ transactor }: Dependencies, { id, ownerId, name, signedInThrough }: Input) =>
  transactor.run(async (unitOfWork) => {
    requireWorkspaceCreation(signedInThrough)
    await unitOfWork.workspaces.add({ id: workspaceId(id), name })
    await unitOfWork.memberships.add(founderMembership(workspaceId(id), ownerId))
  })
