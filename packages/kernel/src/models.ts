export type ModelTier = 'large' | 'medium' | 'small'
export type CatalogModel = Readonly<{
  id: string
  provider: string
  name: string
  tier: ModelTier
  contextWindow: number
  dollarsPerMillionInputTokens?: number
  dollarsPerMillionOutputTokens?: number
}>

const entry = (
  id: string,
  name: string,
  tier: ModelTier,
  contextWindow: number,
  prices: [input: number, output: number] | [] = [],
): CatalogModel => ({
  id,
  provider: id.split('/')[0] ?? '',
  name,
  tier,
  contextWindow,
  dollarsPerMillionInputTokens: prices[0],
  dollarsPerMillionOutputTokens: prices[1],
})

export const modelCatalog: readonly CatalogModel[] = [
  entry('anthropic/claude-opus-5-5', 'Opus 5.5', 'large', 200_000),
  entry('openai/gpt-5', 'GPT-5', 'large', 400_000),
  entry('mistral/mistral-large-latest', 'Mistral Large', 'large', 128_000),
  entry('fake/fake-large', 'Fake large', 'large', 200_000, [30, 30]),
  entry('anthropic/claude-sonnet-5-5', 'Sonnet 5.5', 'medium', 200_000),
  entry('openai/gpt-5-mini', 'GPT-5 mini', 'medium', 400_000),
  entry('mistral/mistral-medium-latest', 'Mistral Medium', 'medium', 128_000),
  entry('fake/fake-medium', 'Fake medium', 'medium', 200_000, [15, 15]),
  entry('anthropic/claude-haiku-4-5', 'Haiku 4.5', 'small', 200_000, [1, 5]),
  entry('openai/gpt-5-nano', 'GPT-5 nano', 'small', 400_000),
  entry('mistral/mistral-small-latest', 'Mistral Small', 'small', 128_000),
  entry('fake/fake-small', 'Fake small', 'small', 200_000, [6, 6]),
  entry('fake-small/fake-small', 'Fake small', 'small', 200_000, [6, 6]),
]

const tiersFrom: Record<ModelTier, ModelTier[]> = {
  large: ['large', 'medium', 'small'],
  medium: ['medium', 'small', 'large'],
  small: ['small', 'medium', 'large'],
}

export const catalogModelOf = (id: string | null | undefined) => modelCatalog.find((model) => model.id === id)
export const modelNameOf = (id: string) => catalogModelOf(id)?.name ?? id.split('/').at(-1) ?? id
export const providersOfGatewayRefs = (refs: readonly string[]) => [
  ...new Set(refs.flatMap((ref) => ref.match(/^gateway:([a-z-]+)\//)?.[1] ?? [])),
]
export const reachableModelsOf = (providers: readonly string[]) =>
  modelCatalog.filter((model) => providers.includes(model.provider))
export const nearestModelOf = (reachable: readonly CatalogModel[], tier: ModelTier) =>
  tiersFrom[tier].flatMap((candidate) => reachable.find((model) => model.tier === candidate) ?? [])[0]
export const defaultModelOf = (reachable: readonly CatalogModel[]) => nearestModelOf(reachable, 'medium')
export const cheapestModelOf = (reachable: readonly CatalogModel[]) => reachable.at(-1)
export const rereadDollarsOf = (id: string, tokens: number | null) => {
  const price = catalogModelOf(id)?.dollarsPerMillionInputTokens
  return price === undefined || tokens === null ? undefined : (tokens * price) / 1_000_000
}
