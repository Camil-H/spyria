import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import type { DisplayName } from '../domain/display-name.ts'
import { renameMember as renameMemberRecord } from '../domain/member.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; name: DisplayName }

export const renameMember = ({ transactor }: Dependencies, { workspaceId, memberId, name }: Input) =>
  transactor.run(async ({ members }) => {
    await members.save(renameMemberRecord(await members.get(workspaceId, memberId), name))
  })
