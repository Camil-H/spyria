import { type CredentialId, nonBlank } from '@spyria/kernel'
import { BlankProvider, UnsupportedProvider } from './errors.ts'
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

const gatewayProviders: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  mistral: 'mistral',
  typesafe: 'typesafe',
  openrouter: 'openrouter',
  google: 'gemini',
  gemini: 'gemini',
  xai: 'xai',
  deepseek: 'deepseek',
  zai: 'zai',
  'z.ai': 'zai',
}

type NewLlmCredential = Omit<LlmCredential, 'last4' | 'gatewayProvider'> & { secret: Secret }

export const newLlmCredential = ({ secret, provider, ...fields }: NewLlmCredential): LlmCredential => {
  const trimmedProvider = nonBlank(provider, BlankProvider)
  const gatewayProvider = gatewayProviders[trimmedProvider.toLowerCase()]
  if (!gatewayProvider) throw new UnsupportedProvider(trimmedProvider)
  return { ...fields, provider: trimmedProvider, gatewayProvider, last4: secret.last4() }
}
