import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import { BlankProvider } from './errors.ts'
import type { Secret } from './secret.ts'

export type LlmCredential = Readonly<{
  id: CredentialId
  workspaceId: WorkspaceId
  memberId: MemberId
  provider: string
  kind: 'api-key' | 'plan-login'
  last4: string
  status: string | null
}>

type NewLlmCredential = Omit<LlmCredential, 'last4' | 'status'> & { secret: Secret; status: string | null }

export const newLlmCredential = ({ secret, provider, ...fields }: NewLlmCredential): LlmCredential => {
  const trimmedProvider = provider.trim()
  if (trimmedProvider === '') throw new BlankProvider()
  return { ...fields, provider: trimmedProvider, last4: secret.last4() }
}
