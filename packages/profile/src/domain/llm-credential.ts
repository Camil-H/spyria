import type { CredentialId, MemberId, WorkspaceId } from '@hq/kernel'
import { BlankProvider, UnsupportedProvider } from './errors.ts'
import type { Secret } from './secret.ts'

export const profileJobTypes = { gatewaySync: 'profile.gateway-sync' } as const

export type LlmCredential = Readonly<{
  id: CredentialId
  workspaceId: WorkspaceId
  memberId: MemberId
  provider: string
  gatewayProvider: string
  last4: string
}>
export type GatewayKey = Readonly<{ provider: string; id: string }>

const gatewayProviders: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  mistral: 'mistral',
  typesafe: 'typesafe',
  fake: 'fake',
  'fake-small': 'fake-small',
}
const gatewayKeyRefPattern = /^gateway:([a-z-]+)\/(.+)$/

export const gatewayKeyRefOf = (key: GatewayKey) => `gateway:${key.provider}/${key.id}`

export const gatewayKeyOf = (ref: string): GatewayKey | undefined => {
  const [, provider, id] = ref.match(gatewayKeyRefPattern) ?? []
  return provider && id ? { provider, id } : undefined
}

type NewLlmCredential = Omit<LlmCredential, 'last4' | 'gatewayProvider'> & { secret: Secret }

export const newLlmCredential = ({ secret, provider, ...fields }: NewLlmCredential): LlmCredential => {
  const trimmedProvider = provider.trim()
  if (trimmedProvider === '') throw new BlankProvider()
  const gatewayProvider = gatewayProviders[trimmedProvider.toLowerCase()]
  if (!gatewayProvider) throw new UnsupportedProvider(trimmedProvider)
  return { ...fields, provider: trimmedProvider, gatewayProvider, last4: secret.last4() }
}
