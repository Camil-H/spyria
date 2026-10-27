import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { Avatar } from '../domain/avatar.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; avatar: Avatar | null }

export const changeAvatar = ({ transactor }: Dependencies, { workspaceId, memberId, avatar }: Input) =>
  transactor.run(async ({ members }) => {
    await members.save({ ...(await members.get(workspaceId, memberId)), avatar })
  })
