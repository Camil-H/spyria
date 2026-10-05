import type { ZeroContext } from '@hq/db/zero-queries'
import type { Transaction } from '@rocicorp/zero'
import { Secret } from '../domain/secret.ts'
import { createZeroTransactor } from '../integrations/zero-transactor.ts'
import { addLlmCredential } from '../operations/add-llm-credential.ts'

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

export const addLlmCredentialFromRequest = (tx: Transaction, context: ZeroContext, body: unknown) => {
  const { provider, secret } = (body ?? {}) as Record<string, unknown>
  return addLlmCredential(
    { transactor: createZeroTransactor(tx, context) },
    {
      id: crypto.randomUUID(),
      workspaceId: context.workspaceId,
      memberId: context.userId,
      provider: textOf(provider),
      secret: new Secret(textOf(secret)),
    },
  )
}
