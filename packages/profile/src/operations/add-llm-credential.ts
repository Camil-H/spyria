import { credentialId, type IdGenerator, type MemberId, type WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { newLlmCredential } from '../domain/llm-credential.ts'
import type { Secret } from '../domain/secret.ts'

type Dependencies = { transactor: ProfileTransactor; idGenerator: IdGenerator }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; provider: string; secret: Secret }

export const addLlmCredential = async ({ transactor, idGenerator }: Dependencies, input: Input) => {
  const credential = newLlmCredential({ ...input, id: credentialId(idGenerator.next()) })
  await transactor.run(async ({ llmCredentials, secrets }) => {
    await llmCredentials.add(credential, await secrets.keep(credential.workspaceId, input.secret))
  })
}
