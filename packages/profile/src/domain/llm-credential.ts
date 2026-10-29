import { type AiProviderAllowList, aiProviderOf, type CredentialId, isAllowedProvider, nonBlank } from '@spyria/kernel'
import { BlankProvider, ProviderNotAllowed, UnsupportedProvider } from './errors.ts'
import type { Secret } from './secret.ts'

export const profileJobTypes = {
  gatewaySync: 'profile.gateway-sync',
  toolServerRemoval: 'profile.tool-server-removal',
} as const

export type LlmCredential = Readonly<{
  id: CredentialId
  provider: string
  gatewayProvider: string
  last4: string
}>

type NewLlmCredential = Omit<LlmCredential, 'last4' | 'gatewayProvider'> & {
  secret: Secret
  allowList: AiProviderAllowList | null
}

export const newLlmCredential = ({ secret, provider, allowList, ...fields }: NewLlmCredential): LlmCredential => {
  const trimmedProvider = nonBlank(provider, BlankProvider)
  const gatewayProvider = aiProviderOf(trimmedProvider)
  if (!gatewayProvider) throw new UnsupportedProvider(trimmedProvider)
  if (!isAllowedProvider(allowList, gatewayProvider.id)) throw new ProviderNotAllowed(gatewayProvider.name)
  return { ...fields, provider: trimmedProvider, gatewayProvider: gatewayProvider.id, last4: secret.last4() }
}
