import { credentialId, type MemberId, type WorkspaceId } from '@hq/kernel'
import type { LlmGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { newLlmCredential } from '../domain/llm-credential.ts'
import type { Secret } from '../domain/secret.ts'
import { syncMemberGatewayKey } from './sync-member-gateway-key.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: LlmGateway }
type Input = { id: string; workspaceId: WorkspaceId; memberId: MemberId; provider: string; secret: Secret }

export const addLlmCredential = async (dependencies: Dependencies, { id, ...input }: Input) => {
  const { transactor, gateway } = dependencies
  const credential = newLlmCredential({ ...input, id: credentialId(id) })
  const key = await gateway.addProviderKey({
    provider: credential.gatewayProvider,
    name: `cred_${id}`,
    secret: input.secret,
  })
  try {
    await transactor.run(({ llmCredentials }) => llmCredentials.add(credential, key))
  } catch (error) {
    await gateway.removeProviderKey(key)
    throw error
  }
  try {
    await syncMemberGatewayKey(dependencies, input)
  } catch (error) {
    await transactor.run(({ llmCredentials }) =>
      llmCredentials.remove(input.workspaceId, input.memberId, credential.id),
    )
    await gateway.removeProviderKey(key)
    throw error
  }
}
