import { credentialId, type IdGenerator, type MemberId, type WorkspaceId } from '@hq/kernel'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { newLlmCredential } from '../domain/llm-credential.ts'
import { Secret } from '../domain/secret.ts'

type Dependencies = { transactor: ProfileTransactor; idGenerator: IdGenerator }
type Input = { workspaceId: WorkspaceId; memberId: MemberId; provider: string; secret: string }

export const addLlmCredential = async ({ transactor, idGenerator }: Dependencies, { secret, ...fields }: Input) => {
  const credential = newLlmCredential({ ...fields, id: credentialId(idGenerator.next()), secret: new Secret(secret) })
  await transactor.run(({ llmCredentials }) => llmCredentials.add(credential))
}
