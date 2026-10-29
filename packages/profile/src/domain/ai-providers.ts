import { type AiProviderAllowList, aiProviderNameOf, aiProviders, modelNameOf, providerOf } from '@spyria/kernel'
import { ModelOfAnotherProvider, UnsupportedProvider } from './errors.ts'

export const checkedAllowList = (allowList: AiProviderAllowList | null): AiProviderAllowList | null => {
  if (allowList === null) return null
  const entries = Object.entries(allowList).flatMap(([provider, models]) =>
    models === undefined || (models !== 'all' && models.length === 0) ? [] : [[provider, models] as const],
  )
  for (const [provider, models] of entries) {
    if (!aiProviders.some(({ id }) => id === provider)) throw new UnsupportedProvider(provider)
    const foreignModel = models === 'all' ? undefined : models.find((model) => providerOf(model) !== provider)
    if (foreignModel) throw new ModelOfAnotherProvider(foreignModel, aiProviderNameOf(provider))
  }
  return Object.fromEntries(entries)
}

export const allowListSummaryOf = (allowList: AiProviderAllowList | null) =>
  allowList === null
    ? ['Every provider and model']
    : Object.entries(allowList).map(([provider, models]) =>
        models === 'all' || models === undefined
          ? aiProviderNameOf(provider)
          : `${aiProviderNameOf(provider)} (${models.map(modelNameOf).join(', ')})`,
      )

const everyProvider = (): AiProviderAllowList => Object.fromEntries(aiProviders.map(({ id }) => [id, 'all' as const]))

export const withProvider = (allowList: AiProviderAllowList | null, provider: string, isAllowed: boolean) => {
  const { [provider]: _, ...others } = allowList ?? everyProvider()
  return isAllowed ? { ...others, [provider]: 'all' as const } : others
}

export const withModels = (
  allowList: AiProviderAllowList | null,
  provider: string,
  models: 'all' | readonly string[],
): AiProviderAllowList => ({ ...(allowList ?? everyProvider()), [provider]: models })
