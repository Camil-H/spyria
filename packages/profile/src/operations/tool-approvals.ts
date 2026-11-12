import type { ProfileTransactor } from '../contracts/transactor.ts'
import { type ApprovalChange, preferenceWith } from '../domain/tool-approval.ts'

type Dependencies = { transactor: ProfileTransactor }

export const setToolApproval = ({ transactor }: Dependencies, input: ApprovalChange & { connectionId: string }) =>
  transactor.run(async ({ workspaceConnections, toolApprovals }) => {
    const connection = await workspaceConnections.get(transactor.member.workspaceId, input.connectionId)
    await toolApprovals.save(preferenceWith(connection, await toolApprovals.get(connection.id), input))
  })
