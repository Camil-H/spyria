import type { MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId }

export const removeMemberProfile = ({ transactor }: Dependencies, { workspaceId, memberId }: Input) =>
  transactor.run(async ({ llmCredentials, gatewayJobs, personalConnections }) => {
    for (const key of await llmCredentials.removeAll(workspaceId, memberId))
      await gatewayJobs.syncLater({ workspaceId, memberId, key })
    await personalConnections.removeAll(workspaceId, memberId)
  })
