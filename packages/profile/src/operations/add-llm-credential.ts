import { credentialId } from '@spyria/kernel'
import type { LlmGateway, ToolGateway } from '../contracts/repositories.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { newLlmCredential } from '../domain/llm-credential.ts'
import type { Secret } from '../domain/secret.ts'
import { syncMemberGatewayKey } from './sync-member-gateway-key.ts'

type Dependencies = { transactor: ProfileTransactor; gateway: LlmGateway & ToolGateway }
type Input = { id: string; provider: string; secret: Secret }

export const addLlmCredential = async (dependencies: Dependencies, { id, ...input }: Input) => {
  const { gateway, transactor } = dependencies
  const allowList = await transactor.run(({ aiProviders }) => aiProviders.allowList())
  const credential = newLlmCredential({ ...input, id: credentialId(id), allowList })
  const key = await gateway.addProviderKey({
    provider: credential.gatewayProvider,
    name: `cred_${id}`,
    secret: input.secret,
  })
  try {
    await syncMemberGatewayKey(dependencies, { added: { credential, key } })
  } catch (error) {
    await gateway.removeProviderKey(key)
    throw error
  }
}
