import { type AiProviderAllowList, aiProviderNameOf, aiProviders } from '@spyria/kernel'
import { UnsupportedProvider } from './errors.ts'

export const checkedAllowList = (allowList: AiProviderAllowList | null): AiProviderAllowList | null => {
  if (allowList === null) return null
  const unknown = allowList.find((provider) => !aiProviders.some(({ id }) => id === provider))
  if (unknown !== undefined) throw new UnsupportedProvider(unknown)
  return aiProviders.flatMap(({ id }) => (allowList.includes(id) ? id : []))
}

export const allowListSummaryOf = (allowList: AiProviderAllowList | null) =>
  allowList === null ? ['Every provider'] : allowList.map(aiProviderNameOf)

export const withProvider = (allowList: AiProviderAllowList | null, provider: string, isAllowed: boolean) => {
  const others = (allowList ?? aiProviders.map(({ id }) => id)).filter((id) => id !== provider)
  return isAllowed ? [...others, provider] : others
}
