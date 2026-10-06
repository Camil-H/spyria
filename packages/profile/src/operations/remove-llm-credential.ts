import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; credentialId: CredentialId }

export const removeLlmCredential = ({ transactor }: Dependencies, { workspaceId, memberId, credentialId }: Input) =>
  transactor.run(async ({ llmCredentials, gatewayJobs }) => {
    const key = await llmCredentials.remove(workspaceId, memberId, credentialId)
    if (key) await gatewayJobs.syncLater({ workspaceId, memberId, key })
  })
