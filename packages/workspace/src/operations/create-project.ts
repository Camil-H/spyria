import { type IdGenerator, projectId, type WorkspaceId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: Transactor; idGenerator: IdGenerator }
type Input = { workspaceId: WorkspaceId; name: Name }

export const createProject = ({ transactor, idGenerator }: Dependencies, { workspaceId, name }: Input) =>
  transactor.run((unitOfWork) =>
    unitOfWork.projects.add({ id: projectId(idGenerator.next()), workspaceId, name, archived: false }),
  )
