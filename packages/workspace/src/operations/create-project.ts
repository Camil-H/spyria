import { projectId, type WorkspaceId } from '@spyria/kernel'
import type { WorkspaceTransactor } from '../contracts/transactor.ts'
import type { Name } from '../domain/name.ts'

type Dependencies = { transactor: WorkspaceTransactor }
type Input = { id: string; workspaceId: WorkspaceId; name: Name }

export const createProject = ({ transactor }: Dependencies, { id, workspaceId, name }: Input) =>
  transactor.run((unitOfWork) => unitOfWork.projects.add({ id: projectId(id), workspaceId, name, archived: false }))
