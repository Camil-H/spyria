import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { DisplayName } from '../domain/display-name.ts'

type Dependencies = { transactor: ProfileTransactor }

export const renameMember = ({ transactor }: Dependencies, { name }: { name: DisplayName }) =>
  transactor.run(async ({ members }) => {
    await members.save({ ...(await members.get()), name })
  })
