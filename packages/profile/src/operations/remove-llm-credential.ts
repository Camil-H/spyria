import type { CredentialId } from '@spyria/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'

type Dependencies = { transactor: ProfileTransactor }

export const removeLlmCredential = ({ transactor }: Dependencies, { credentialId }: { credentialId: CredentialId }) =>
  transactor.run(async ({ llmCredentials, gatewayJobs }) => {
    const key = await llmCredentials.remove(credentialId)
    if (key) await gatewayJobs.syncLater({ key })
  })
