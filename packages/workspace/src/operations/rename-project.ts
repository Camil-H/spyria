import type { ProjectId } from '@hq/kernel'
import type { Transactor } from '../contracts/transactor.ts'
import type { Name } from '../domain/name.ts'
import { renamedProject } from '../domain/project.ts'

type Dependencies = { transactor: Transactor }
type Input = { projectId: ProjectId; name: Name }

export const renameProject = ({ transactor }: Dependencies, { projectId, name }: Input) =>
  transactor.run(async (unitOfWork) => {
    await unitOfWork.projects.save(renamedProject(await unitOfWork.projects.get(projectId), name))
  })
