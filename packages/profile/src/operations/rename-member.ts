import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { DisplayName } from '../domain/display-name.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; name: DisplayName }

export const renameMember = ({ transactor }: Dependencies, { workspaceId, memberId, name }: Input) =>
  transactor.run(async ({ members }) => {
    await members.save({ ...(await members.get(workspaceId, memberId)), name })
  })
