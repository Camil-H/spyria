export type ModelTier = 'large' | 'medium' | 'small'
export type RoutableModel = Readonly<{ id: string; name: string; tier?: ModelTier }>
export type ListedModel = Readonly<{
  id: string
  contextWindow?: number
  dollarsPerMillionInputTokens?: number
  dollarsPerMillionOutputTokens?: number
}>
export type Model = RoutableModel & Omit<ListedModel, 'id'>

const routableModels: RoutableModel[] = [
  { id: 'anthropic/claude-opus-5-5', name: 'Opus 5.5', tier: 'large' },
  { id: 'openai/gpt-5', name: 'GPT-5', tier: 'large' },
  { id: 'mistral/mistral-large-latest', name: 'Mistral Large', tier: 'large' },
  { id: 'anthropic/claude-sonnet-5-5', name: 'Sonnet 5.5', tier: 'medium' },
  { id: 'openai/gpt-5-mini', name: 'GPT-5 mini', tier: 'medium' },
  { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', tier: 'medium' },
  { id: 'anthropic/claude-haiku-5-5', name: 'Haiku 5.5', tier: 'small' },
  { id: 'openai/gpt-5-nano', name: 'GPT-5 nano', tier: 'small' },
  { id: 'mistral/mistral-small-latest', name: 'Mistral Small', tier: 'small' },
  { id: 'typesafe/jev-latest', name: 'Jev' },
]
const tiersFrom: Record<ModelTier, ModelTier[]> = {
  large: ['large', 'medium', 'small'],
  medium: ['medium', 'small', 'large'],
  small: ['small', 'medium', 'large'],
}

export const addRoutableModels = (models: readonly RoutableModel[]) => {
  routableModels.push(...models.filter((model) => !routableModels.some(({ id }) => id === model.id)))
}
export const routableModelNames = () => Object.fromEntries(routableModels.map(({ id, name }) => [id, name]))
export const routableModelOf = (text: string) => {
  const wanted = text.trim().toLowerCase()
  return routableModels.find(
    ({ id, name }) => id === wanted || id.endsWith(`/${wanted}`) || name.toLowerCase() === wanted,
  )
}
export const modelNameOf = (id: string) => routableModels.find((model) => model.id === id)?.name ?? id
export const providersOfGatewayRefs = (refs: readonly string[]) => [
  ...new Set(refs.flatMap((ref) => ref.match(/^gateway:([a-z-]+)\//)?.[1] ?? [])),
]
export const reachableModelsOf = (providers: readonly string[]): Model[] =>
  routableModels.filter((model) => providers.includes(model.id.split('/')[0] ?? ''))
export const withPricesOf = (models: readonly Model[], listed: readonly ListedModel[]): Model[] =>
  models.map((model) => ({ ...listed.find((listing) => listing.id === model.id), ...model }))
export const isDecisionModel = (model: Model) => model.tier === undefined
export const chatModelsOf = (models: readonly Model[]) => models.filter((model) => !isDecisionModel(model))
export const nearestModelOf = (models: readonly Model[], tier: ModelTier) =>
  tiersFrom[tier].flatMap((candidate) => models.find((model) => model.tier === candidate) ?? [])[0]
export const tierOf = (id: string | null) => routableModels.find((model) => model.id === id)?.tier
export const defaultModelOf = (models: readonly Model[]) => nearestModelOf(models, 'medium')
const smallFirst: (ModelTier | undefined)[] = ['small', 'medium', 'large']
export const cheapestModelOf = (models: readonly Model[]) =>
  models
    .toSorted((first, second) => smallFirst.indexOf(first.tier) - smallFirst.indexOf(second.tier))
    .toSorted(
      (first, second) =>
        (first.dollarsPerMillionInputTokens ?? Number.POSITIVE_INFINITY) -
        (second.dollarsPerMillionInputTokens ?? Number.POSITIVE_INFINITY),
    )[0]
export const classifierModelOf = (models: readonly Model[]) =>
  cheapestModelOf(models.filter(isDecisionModel)) ?? cheapestModelOf(chatModelsOf(models))
export const rereadDollarsOf = (model: ListedModel | undefined, tokens: number | null) => {
  const price = model?.dollarsPerMillionInputTokens
  return price === undefined || tokens === null ? undefined : (tokens * price) / 1_000_000
}
