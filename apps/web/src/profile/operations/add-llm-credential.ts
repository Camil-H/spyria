import { credentialId, type IdGenerator, type MemberId, type WorkspaceId } from '@hq/kernel'
import type { PlanLoginProbe } from '../contracts/plan-login-probe.ts'
import type { ProfileTransactor } from '../contracts/transactor.ts'
import { newLlmCredential } from '../domain/llm-credential.ts'
import { Secret } from '../domain/secret.ts'

type Dependencies = { transactor: ProfileTransactor; idGenerator: IdGenerator; planLoginProbe: PlanLoginProbe }
type Input = {
  workspaceId: WorkspaceId
  memberId: MemberId
  provider: string
  kind: 'api-key' | 'plan-login'
  label: string
  secret: string
}

export const addLlmCredential = async (
  { transactor, idGenerator, planLoginProbe }: Dependencies,
  { secret: rawSecret, ...fields }: Input,
) => {
  const secret = new Secret(rawSecret)
  const status =
    fields.kind === 'plan-login' ? await planLoginProbe.verify({ harness: fields.provider, credential: secret }) : null
  const credential = newLlmCredential({ ...fields, id: credentialId(idGenerator.next()), secret, status })
  await transactor.run(({ llmCredentials }) => llmCredentials.add(credential))
}
