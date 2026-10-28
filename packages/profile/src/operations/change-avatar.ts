import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { Avatar } from '../domain/avatar.ts'

type Dependencies = { transactor: ProfileTransactor }

export const changeAvatar = ({ transactor }: Dependencies, { avatar }: { avatar: Avatar | null }) =>
  transactor.run(async ({ members }) => {
    await members.save({ ...(await members.get()), avatar })
  })
