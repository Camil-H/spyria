import { expect, test } from 'bun:test'
import {
  addRoutableModels,
  chatModelsOf,
  classifierModelOf,
  isPickableModel,
  type ListedModel,
  listedChatModelIdsOf,
  modelNameOf,
  nearestModelOf,
  providersOfGatewayRefs,
  reachableModelsOf,
  rereadDollarsOf,
  withPricesOf,
} from './models.ts'

addRoutableModels([
  { id: 'fake/fake-large', name: 'Fake large', tier: 'large' },
  { id: 'fake/fake-medium', name: 'Fake medium', tier: 'medium' },
  { id: 'fake/fake-small', name: 'Fake small', tier: 'small' },
  { id: 'fake-small/fake-small', name: 'Fake small', tier: 'small' },
])
const priced = (id: string, input: number): ListedModel => ({
  id,
  dollarsPerMillionInputTokens: input,
  dollarsPerMillionOutputTokens: input,
})
const fake = reachableModelsOf(['fake'])
const smallOnly = reachableModelsOf(['fake-small'])
const jev = reachableModelsOf(['typesafe'])
const idsOf = (models: readonly { id: string }[]) => models.map((model) => model.id)

test('reachable models are the routable ones on the providers of the member keys', () => {
  expect(providersOfGatewayRefs(['gateway:fake/1', 'gateway:fake-small/2', 'gateway:fake/3', 'legacy'])).toEqual([
    'fake',
    'fake-small',
  ])
  expect(idsOf(fake)).toEqual(['fake/fake-large', 'fake/fake-medium', 'fake/fake-small'])
  expect(idsOf(smallOnly)).toEqual(['fake-small/fake-small'])
  expect(idsOf(jev)).toEqual(['typesafe/jev-latest'])
  expect(reachableModelsOf([])).toEqual([])
  expect(idsOf(chatModelsOf([...fake, ...jev]))).toEqual(idsOf(fake))
  expect(chatModelsOf(jev)).toEqual([])
})

test.each([
  ['gemini', ['gemini/gemini-pro-latest', 'gemini/gemini-flash-latest', 'gemini/gemini-flash-lite-latest']],
  ['xai', ['xai/grok-4.7', 'xai/grok-4.3', 'xai/grok-code-fast-1']],
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
  expect(withPricesOf(fake, [priced('fake/fake-large', 30), priced('openai/gpt-image-1', 40)])).toEqual([
    {
      id: 'fake/fake-large',
      name: 'Fake large',
      tier: 'large',
      dollarsPerMillionInputTokens: 30,
      dollarsPerMillionOutputTokens: 30,
    },
    { id: 'fake/fake-medium', name: 'Fake medium', tier: 'medium' },
    { id: 'fake/fake-small', name: 'Fake small', tier: 'small' },
  ])
})

test('the nearest model keeps the tier, then goes below, then above', () => {
  expect(nearestModelOf(fake, 'large')?.id).toBe('fake/fake-large')
  expect(nearestModelOf(smallOnly, 'large')?.id).toBe('fake-small/fake-small')
  expect(
    nearestModelOf(
      fake.filter((model) => model.tier === 'large'),
      'medium',
    )?.id,
  ).toBe('fake/fake-large')
  expect(nearestModelOf(fake, 'medium')?.id).toBe('fake/fake-medium')
  expect(nearestModelOf(jev, 'medium')).toBeUndefined()
})

test('the classifier is the cheapest reachable decision model, else the cheapest chat model, else the smallest tier', () => {
  const prices = [priced('fake/fake-large', 30), priced('fake/fake-medium', 5), priced('fake/fake-small', 6)]
  expect(classifierModelOf([...fake, ...jev])?.id).toBe('typesafe/jev-latest')
  expect(classifierModelOf(withPricesOf(fake, prices))?.id).toBe('fake/fake-medium')
  expect(classifierModelOf(fake)?.id).toBe('fake/fake-small')
  expect(classifierModelOf([])).toBeUndefined()
})

test('the reread estimate uses the conversation tokens and the input price, unknown without either', () => {
  expect(rereadDollarsOf(priced('fake/fake-large', 30), 2_000_000)).toBe(60)
  expect(rereadDollarsOf(priced('fake/fake-large', 30), null)).toBeUndefined()
  expect(rereadDollarsOf({ id: 'custom/unpriced' }, 1000)).toBeUndefined()
  expect(rereadDollarsOf(undefined, 1000)).toBeUndefined()
})

test('an unknown model id is shown as itself', () => {
  expect(modelNameOf('somewhere/other-model')).toBe('somewhere/other-model')
})
