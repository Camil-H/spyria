import type { MemberId, WorkspaceId } from '@spyria/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId }

export const removeMemberProfile = ({ transactor }: Dependencies, { workspaceId, memberId }: Input) =>
  transactor.run(async ({ llmCredentials, gatewayJobs, personalConnections, workspaceConnections }) => {
    const keys = await llmCredentials.removeAll(workspaceId, memberId)
    if (keys.length === 0) await gatewayJobs.syncLater({ workspaceId, memberId, isLeaving: true })
    for (const key of keys) await gatewayJobs.syncLater({ workspaceId, memberId, key, isLeaving: true })
    await personalConnections.removeAll(workspaceId, memberId)
    await workspaceConnections.removeRestrictionsOf(workspaceId, memberId)
  })
