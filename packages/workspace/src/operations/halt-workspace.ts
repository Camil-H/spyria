import type { DeletedWorkspaceTransactor } from '../contracts/transactor.ts'

export const haltWorkspace = ({ transactor }: { transactor: DeletedWorkspaceTransactor }) =>
  transactor.run(async ({ deletedWorkspace }) => {
    if (await deletedWorkspace.isDeleted()) await deletedWorkspace.halt()
  })
