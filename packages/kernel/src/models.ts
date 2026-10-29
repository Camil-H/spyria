export type ModelTier = 'large' | 'medium' | 'small'
export type RoutableModel = Readonly<{ id: string; name: string; tier?: ModelTier }>
export type ListedModel = Readonly<{
  id: string
  contextWindow?: number
  dollarsPerMillionInputTokens?: number
  dollarsPerMillionOutputTokens?: number
}>
export type Model = RoutableModel & Omit<ListedModel, 'id'>

export const aiProviders = [
  { id: 'anthropic', name: 'Anthropic', aliases: [] },
  { id: 'openai', name: 'OpenAI', aliases: [] },
  { id: 'gemini', name: 'Google Gemini', aliases: ['google'] },
  { id: 'mistral', name: 'Mistral', aliases: [] },
  { id: 'xai', name: 'xAI', aliases: [] },
  { id: 'deepseek', name: 'DeepSeek', aliases: [] },
  { id: 'zai', name: 'Z.ai', aliases: ['z.ai'] },
  { id: 'openrouter', name: 'OpenRouter', aliases: [] },
  { id: 'typesafe', name: 'TypeSafe', aliases: [] },
] as const satisfies readonly { id: string; name: string; aliases: readonly string[] }[]
export type AiProviderId = (typeof aiProviders)[number]['id']
export type AiProviderAllowList = readonly string[]

export const aiProviderAllowListFrom = (stored: unknown): AiProviderAllowList | null => {
  if (Array.isArray(stored)) return stored.filter((provider): provider is string => typeof provider === 'string')
  return stored !== null && typeof stored === 'object' ? Object.keys(stored) : null
}

export const aiProviderOf = (text: string) => {
  const wanted = text.trim().toLowerCase()
  return aiProviders.find(
    ({ id, name, aliases }) =>
      id === wanted || name.toLowerCase() === wanted || (aliases as readonly string[]).includes(wanted),
  )
}
export const aiProviderNameOf = (id: string) => aiProviders.find((provider) => provider.id === id)?.name ?? id

const routableModels: readonly RoutableModel[] = [
  { id: 'anthropic/claude-opus-5-5', name: 'Opus 5.5', tier: 'large' },
  { id: 'openai/gpt-5', name: 'GPT-5', tier: 'large' },
  { id: 'mistral/mistral-large-latest', name: 'Mistral Large', tier: 'large' },
  { id: 'anthropic/claude-sonnet-5-5', name: 'Sonnet 5.5', tier: 'medium' },
  { id: 'openai/gpt-5-mini', name: 'GPT-5 mini', tier: 'medium' },
  { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', tier: 'medium' },
  { id: 'anthropic/claude-haiku-5-5', name: 'Haiku 5.5', tier: 'small' },
  { id: 'openai/gpt-5-nano', name: 'GPT-5 nano', tier: 'small' },
  { id: 'mistral/mistral-small-latest', name: 'Mistral Small', tier: 'small' },
  { id: 'gemini/gemini-pro-latest', name: 'Gemini Pro', tier: 'large' },
  { id: 'gemini/gemini-flash-latest', name: 'Gemini Flash', tier: 'medium' },
  { id: 'gemini/gemini-flash-lite-latest', name: 'Gemini Flash-Lite', tier: 'small' },
  { id: 'xai/grok-4.7', name: 'Grok 4.7', tier: 'large' },
  { id: 'xai/grok-4.3', name: 'Grok 4.3', tier: 'medium' },
  { id: 'xai/grok-code-fast', name: 'Grok Code Fast', tier: 'small' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', tier: 'large' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash', tier: 'medium' },
  { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek V3.2', tier: 'small' },
  { id: 'zai/glm-5.3', name: 'GLM-5.3', tier: 'large' },
  { id: 'zai/glm-4.7', name: 'GLM-4.7', tier: 'medium' },
  { id: 'zai/glm-5.3-flash', name: 'GLM-5.3 Flash', tier: 'small' },
  { id: 'openrouter/anthropic/claude-opus-5.5', name: 'OpenRouter Opus 5.5', tier: 'large' },
  { id: 'openrouter/anthropic/claude-sonnet-5.5', name: 'OpenRouter Sonnet 5.5', tier: 'medium' },
  { id: 'openrouter/anthropic/claude-haiku-5.5', name: 'OpenRouter Haiku 5.5', tier: 'small' },
  { id: 'typesafe/jev-latest', name: 'Jev' },
]
const tiersFrom: Record<ModelTier, ModelTier[]> = {
  large: ['large', 'medium', 'small'],
  medium: ['medium', 'small', 'large'],
  small: ['small', 'medium', 'large'],
}

export const routableModelNames = () => Object.fromEntries(routableModels.map(({ id, name }) => [id, name]))
export const routableModelOf = (text: string) => {
  const wanted = text.trim().toLowerCase()
  return routableModels.find(
    ({ id, name }) => id === wanted || id.endsWith(`/${wanted}`) || name.toLowerCase() === wanted,
  )
}
export const modelNameOf = (id: string) => routableModels.find((model) => model.id === id)?.name ?? id
export type GatewayKey = Readonly<{ provider: string; id: string }>
const gatewayKeyRefPattern = /^gateway:([a-z]+)\/(.+)$/
export const gatewayKeyRefOf = (key: GatewayKey) => `gateway:${key.provider}/${key.id}`
export const gatewayKeyOf = (ref: string): GatewayKey | undefined => {
  const [, provider, id] = ref.match(gatewayKeyRefPattern) ?? []
  return provider && id ? { provider, id } : undefined
}
export const providersOfGatewayRefs = (refs: readonly string[]) => [
  ...new Set(refs.flatMap((ref) => gatewayKeyOf(ref)?.provider ?? [])),
]
export const providerOf = (id: string) => id.split('/')[0] ?? ''
export const isAllowedProvider = (allowList: AiProviderAllowList | null, provider: string) =>
  allowList === null || allowList.includes(provider)
export const isAllowedModel = (allowList: AiProviderAllowList | null, id: string) =>
  isAllowedProvider(allowList, providerOf(id))
export const soleRequestedModelOf = (request: unknown) => {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) return undefined
  const routingFields = Object.entries(request).filter(([name]) => ['model', 'fallbacks'].includes(name.toLowerCase()))
  const [field] = routingFields
  return routingFields.length === 1 && field?.[0] === 'model' && typeof field[1] === 'string' ? field[1] : undefined
}
export const allowedModelsOf = <Listed extends { id: string }>(
  allowList: AiProviderAllowList | null,
  models: readonly Listed[],
) => models.filter((model) => isAllowedModel(allowList, model.id))
export const reachableModelsOf = (providers: readonly string[]): Model[] =>
  routableModels.filter((model) => providers.includes(providerOf(model.id)))
export const withPricesOf = (models: readonly Model[], listed: readonly ListedModel[]): Model[] =>
  models.map((model) => ({ ...listed.find((listing) => listing.id === model.id), ...model }))
export const isDecisionModel = (model: Model) => model.tier === undefined
export const chatModelsOf = (models: readonly Model[]) => models.filter((model) => !isDecisionModel(model))
export const listedChatModelIdsOf = (reachable: readonly Model[], listed: readonly ListedModel[]) => {
  const providers = new Set(chatModelsOf(reachable).map(({ id }) => providerOf(id)))
  return [...new Set(listed.flatMap(({ id }) => (providers.has(providerOf(id)) ? id : [])))]
}
export const isPickableModel = (id: string, reachable: readonly Model[], listed: readonly ListedModel[]) =>
  chatModelsOf(reachable).some((model) => model.id === id) || listedChatModelIdsOf(reachable, listed).includes(id)
export const nearestModelOf = (models: readonly Model[], tier: ModelTier) =>
  tiersFrom[tier].flatMap((candidate) => models.find((model) => model.tier === candidate) ?? [])[0]
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
