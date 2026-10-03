import { type IdGenerator, type MemberId, workspaceId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: Transactor; idGenerator: IdGenerator }
type Input = { ownerId: MemberId; name: Name }

export const createWorkspace = ({ transactor, idGenerator }: Dependencies, { ownerId, name }: Input) =>
  transactor.run(async (unitOfWork) => {
    const newWorkspaceId = workspaceId(idGenerator.next())
    await unitOfWork.workspaces.add({ id: newWorkspaceId, name })
    await unitOfWork.memberships.add({ memberId: ownerId, workspaceId: newWorkspaceId })
    return newWorkspaceId
  })
