import { expect, test } from 'bun:test'
import {
  aiProviderOf,
  allowedModelsOf,
  chatModelsOf,
  classifierModelOf,
  gatewayKeyOf,
  gatewayKeyRefOf,
  isAllowedModel,
  isAllowedProvider,
  isPickableModel,
  type ListedModel,
  listedChatModelIdsOf,
  modelNameOf,
  nearestModelOf,
  providersOfGatewayRefs,
  reachableModelsOf,
  rereadDollarsOf,
  soleRequestedModelOf,
  withPricesOf,
} from './models.ts'

const priced = (id: string, input: number): ListedModel => ({
  id,
  dollarsPerMillionInputTokens: input,
  dollarsPerMillionOutputTokens: input,
})
const mistral = reachableModelsOf(['mistral'])
const smallOnly = reachableModelsOf(['xai']).filter((model) => model.tier === 'small')
const jev = reachableModelsOf(['typesafe'])
const idsOf = (models: readonly { id: string }[]) => models.map((model) => model.id)

test('reachable models are the routable ones on the providers of the member keys', () => {
  expect(providersOfGatewayRefs(['gateway:mistral/1', 'gateway:xai/2', 'gateway:mistral/3', 'legacy'])).toEqual([
    'mistral',
    'xai',
  ])
  expect(idsOf(mistral)).toEqual([
    'mistral/mistral-large-latest',
    'mistral/mistral-medium-latest',
    'mistral/mistral-small-latest',
  ])
  expect(idsOf(smallOnly)).toEqual(['xai/grok-code-fast'])
  expect(idsOf(jev)).toEqual(['typesafe/jev-latest'])
  expect(reachableModelsOf([])).toEqual([])
  expect(idsOf(chatModelsOf([...mistral, ...jev]))).toEqual(idsOf(mistral))
  expect(chatModelsOf(jev)).toEqual([])
})

test.each([
  ['gemini', ['gemini/gemini-pro-latest', 'gemini/gemini-flash-latest', 'gemini/gemini-flash-lite-latest']],
  ['xai', ['xai/grok-4.7', 'xai/grok-4.3', 'xai/grok-code-fast']],
  ['deepseek', ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v3.2']],
  ['zai', ['zai/glm-5.3', 'zai/glm-4.7', 'zai/glm-5.3-flash']],
  [
    'openrouter',
    [
      'openrouter/anthropic/claude-opus-5.5',
      'openrouter/anthropic/claude-sonnet-5.5',
      'openrouter/anthropic/claude-haiku-5.5',
    ],
  ],
])('the %s key reaches one curated model per tier, large to small', (provider, ids) => {
  const reachable = reachableModelsOf([provider])
  expect(idsOf(reachable)).toEqual(ids)
  expect(reachable.map((model) => model.tier)).toEqual(['large', 'medium', 'small'])
  expect(nearestModelOf(reachable, 'medium')?.id).toBe(ids[1])
  expect(providersOfGatewayRefs([`gateway:${provider}/key-id`])).toEqual([provider])
})

test('a manual pick is a curated model or a listed model of a reachable chat provider', () => {
  const openRouter = reachableModelsOf(['openrouter'])
  const listed = [
    { id: 'openrouter/moonshotai/kimi-k3' },
    { id: 'openai/gpt-6.1-sol' },
    { id: 'typesafe/jev-2' },
    { id: 'openrouter/moonshotai/kimi-k3' },
  ]
  expect(listedChatModelIdsOf([...openRouter, ...jev], listed)).toEqual(['openrouter/moonshotai/kimi-k3'])
  expect(isPickableModel('openrouter/moonshotai/kimi-k3', openRouter, listed)).toBe(true)
  expect(isPickableModel('openrouter/anthropic/claude-sonnet-5.5', openRouter, [])).toBe(true)
  expect(isPickableModel('openai/gpt-6.1-sol', openRouter, listed)).toBe(false)
  expect(isPickableModel('typesafe/jev-2', jev, listed)).toBe(false)
})

test('listing prices are added to reachable models; unlisted ones stay without a price', () => {
  expect(withPricesOf(mistral, [priced('mistral/mistral-large-latest', 30), priced('openai/gpt-image-1', 40)])).toEqual(
    [
      {
        id: 'mistral/mistral-large-latest',
        name: 'Mistral Large',
        tier: 'large',
        dollarsPerMillionInputTokens: 30,
        dollarsPerMillionOutputTokens: 30,
      },
      { id: 'mistral/mistral-medium-latest', name: 'Mistral Medium', tier: 'medium' },
      { id: 'mistral/mistral-small-latest', name: 'Mistral Small', tier: 'small' },
    ],
  )
})

test('the nearest model keeps the tier, then goes below, then above', () => {
  expect(nearestModelOf(mistral, 'large')?.id).toBe('mistral/mistral-large-latest')
  expect(nearestModelOf(smallOnly, 'large')?.id).toBe('xai/grok-code-fast')
  expect(
    nearestModelOf(
      mistral.filter((model) => model.tier === 'large'),
      'medium',
    )?.id,
  ).toBe('mistral/mistral-large-latest')
  expect(nearestModelOf(mistral, 'medium')?.id).toBe('mistral/mistral-medium-latest')
  expect(nearestModelOf(jev, 'medium')).toBeUndefined()
})

test('the classifier is the cheapest reachable decision model, else the cheapest chat model, else the smallest tier', () => {
  const prices = [
    priced('mistral/mistral-large-latest', 30),
    priced('mistral/mistral-medium-latest', 5),
    priced('mistral/mistral-small-latest', 6),
  ]
  expect(classifierModelOf([...mistral, ...jev])?.id).toBe('typesafe/jev-latest')
  expect(classifierModelOf(withPricesOf(mistral, prices))?.id).toBe('mistral/mistral-medium-latest')
  expect(classifierModelOf(mistral)?.id).toBe('mistral/mistral-small-latest')
  expect(classifierModelOf([])).toBeUndefined()
})

test('the reread estimate uses the conversation tokens and the input price, unknown without either', () => {
  expect(rereadDollarsOf(priced('mistral/mistral-large-latest', 30), 2_000_000)).toBe(60)
  expect(rereadDollarsOf(priced('mistral/mistral-large-latest', 30), null)).toBeUndefined()
  expect(rereadDollarsOf({ id: 'custom/unpriced' }, 1000)).toBeUndefined()
  expect(rereadDollarsOf(undefined, 1000)).toBeUndefined()
})

test('an unknown model id is shown as itself', () => {
  expect(modelNameOf('somewhere/other-model')).toBe('somewhere/other-model')
})

test('a gateway key reference round-trips and refuses anything else', () => {
  const key = { provider: 'openai', id: '8ec7907d-bef5-433b-92b8-df18842db1f2' }
  expect(gatewayKeyOf(gatewayKeyRefOf(key))).toEqual(key)
  expect(gatewayKeyOf('gateway:credential-alice-anthropic')).toBeUndefined()
  expect(gatewayKeyOf('gateway:mistral/')).toBeUndefined()
  expect(gatewayKeyOf('placeholder:abc')).toBeUndefined()
})

test('a provider is found by its id, its name or an alias, and nothing else', () => {
  expect(aiProviderOf(' Google ')?.id).toBe('gemini')
  expect(aiProviderOf('google gemini')?.id).toBe('gemini')
  expect(aiProviderOf('Z.ai')?.id).toBe('zai')
  expect(aiProviderOf('openai')?.name).toBe('OpenAI')
  expect(aiProviderOf('fake')).toBeUndefined()
})

test('without an allow-list every provider and model is allowed; with one, only what it names', () => {
  expect(isAllowedProvider(null, 'fake')).toBe(true)
  expect(isAllowedModel(null, 'fake/fake-medium')).toBe(true)
  const allowList = { anthropic: 'all', openai: ['openai/gpt-5'] } as const
  expect(isAllowedProvider(allowList, 'openai')).toBe(true)
  expect(isAllowedProvider(allowList, 'mistral')).toBe(false)
  expect(isAllowedModel(allowList, 'anthropic/claude-haiku-5-5')).toBe(true)
  expect(isAllowedModel(allowList, 'openai/gpt-5')).toBe(true)
  expect(isAllowedModel(allowList, 'openai/gpt-5-mini')).toBe(false)
  expect(isAllowedModel(allowList, 'mistral/mistral-large-latest')).toBe(false)
  expect(
    allowedModelsOf(allowList, [{ id: 'openai/gpt-5' }, { id: 'openai/gpt-5-nano' }, { id: 'anthropic/x' }]),
  ).toEqual([{ id: 'openai/gpt-5' }, { id: 'anthropic/x' }])
})

test('an allow-list ignores names inherited from objects, and only a request naming one plain model is checked', () => {
  const allowList = { openai: 'all' } as const
  expect(isAllowedProvider(allowList, 'constructor')).toBe(false)
  expect(isAllowedModel(allowList, 'constructor/x')).toBe(false)
  expect(isAllowedModel(allowList, '__proto__/x')).toBe(false)
  expect(soleRequestedModelOf({ model: 'openai/gpt-5', messages: [] })).toBe('openai/gpt-5')
  expect(soleRequestedModelOf({ model: 'openai/gpt-5', Model: 'mistral/x' })).toBeUndefined()
  expect(soleRequestedModelOf({ model: 'openai/gpt-5', fallbacks: ['mistral/x'] })).toBeUndefined()
  expect(soleRequestedModelOf({ MODEL: 'openai/gpt-5' })).toBeUndefined()
  expect(soleRequestedModelOf({ model: 42 })).toBeUndefined()
  expect(soleRequestedModelOf({ messages: [] })).toBeUndefined()
  expect(soleRequestedModelOf(undefined)).toBeUndefined()
})
