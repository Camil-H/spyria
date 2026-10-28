import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }

export const removeMemberProfile = ({ transactor }: Dependencies) =>
  transactor.run(async ({ llmCredentials, gatewayJobs, personalConnections, workspaceConnections }) => {
    const keys = await llmCredentials.removeAll()
    if (keys.length === 0) await gatewayJobs.syncLater({ isLeaving: true })
    for (const key of keys) await gatewayJobs.syncLater({ key, isLeaving: true })
    await personalConnections.removeAll()
    await workspaceConnections.removeRestrictionsOf(transactor.member.workspaceId, transactor.member.memberId)
  })
