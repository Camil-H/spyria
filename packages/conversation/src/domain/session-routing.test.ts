import { expect, test } from 'bun:test'
import {
  addRoutableModels,
  chatModelsOf,
  classifierModelOf,
  defaultModelOf,
  type ListedModel,
  modelNameOf,
  nearestModelOf,
  providersOfGatewayRefs,
  reachableModelsOf,
  rereadDollarsOf,
  withPricesOf,
} from '@hq/kernel'
import { sessionChoiceOf, unreachableSessionNoticeOf } from './session-routing.ts'

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
  expect(defaultModelOf(fake)?.id).toBe('fake/fake-medium')
  expect(defaultModelOf(jev)).toBeUndefined()
})

test('the classifier is the cheapest reachable decision model, else the cheapest chat model, else the smallest tier', () => {
  const prices = [priced('fake/fake-large', 30), priced('fake/fake-medium', 5), priced('fake/fake-small', 6)]
  expect(classifierModelOf([...fake, ...jev])?.id).toBe('typesafe/jev-latest')
  expect(classifierModelOf(withPricesOf(fake, prices))?.id).toBe('fake/fake-medium')
  expect(classifierModelOf(fake)?.id).toBe('fake/fake-small')
  expect(classifierModelOf([])).toBeUndefined()
})

test('names come from the routable list, unknown models keep their id', () => {
  expect(modelNameOf('anthropic/claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(modelNameOf('openai/gpt-5')).toBe('GPT-5')
  expect(modelNameOf('somewhere/other-model')).toBe('somewhere/other-model')
})

test('the reread estimate uses the conversation tokens and the input price, unknown without either', () => {
  expect(rereadDollarsOf(priced('fake/fake-large', 30), 2_000_000)).toBe(60)
  expect(rereadDollarsOf(priced('fake/fake-large', 30), null)).toBeUndefined()
  expect(rereadDollarsOf({ id: 'custom/unpriced' }, 1000)).toBeUndefined()
  expect(rereadDollarsOf(undefined, 1000)).toBeUndefined()
})

const classified = (tier: 'large' | 'medium' | 'small', confidence = 0.9) => ({
  tier: { value: tier, confidence },
  effort: { value: 'low', confidence },
})

test('only a confident large or small classification moves away from the chat default', () => {
  const route = (answers: ReturnType<typeof classified> | undefined, defaultModel = 'fake/fake-medium') =>
    sessionChoiceOf({ reachable: fake, defaultModel, answers })
  expect(route(classified('large'))).toMatchObject({ model: { id: 'fake/fake-large' }, effort: 'low' })
  expect(route(classified('small'))).toMatchObject({ model: { id: 'fake/fake-small' } })
  expect(route(classified('large', 0.8))).toMatchObject({ model: { id: 'fake/fake-large' } })
  expect(route(classified('large', 0.79))).toMatchObject({ model: { id: 'fake/fake-medium' }, effort: 'low' })
  expect(route(classified('medium'))?.model.id).toBe('fake/fake-medium')
  expect(route(undefined)).toMatchObject({ model: { id: 'fake/fake-medium' }, effort: 'medium' })
  expect(route(undefined, 'fake/fake-small')?.model.id).toBe('fake/fake-small')
})

test('an unreachable or missing default falls back to the nearest reachable model of its tier', () => {
  expect(
    sessionChoiceOf({ reachable: fake, defaultModel: 'anthropic/claude-sonnet-5-5', answers: undefined }),
  ).toMatchObject({ model: { id: 'fake/fake-medium' } })
  expect(sessionChoiceOf({ reachable: fake, defaultModel: null, answers: undefined })?.model.id).toBe(
    'fake/fake-medium',
  )
  expect(
    sessionChoiceOf({ reachable: smallOnly, defaultModel: 'fake/fake-medium', answers: classified('large') })?.model.id,
  ).toBe('fake-small/fake-small')
  expect(
    sessionChoiceOf({ reachable: fake, defaultModel: 'anthropic/claude-haiku-4-5', answers: undefined })?.model.id,
  ).toBe('fake/fake-small')
  expect(sessionChoiceOf({ reachable: [], defaultModel: 'fake/fake-medium', answers: undefined })).toBeUndefined()
})

test('a prompter who cannot reach the session model gets the cannot-reach notice', () => {
  expect(unreachableSessionNoticeOf('fake/fake-large')).toBe(
    'Your keys cannot reach Fake large; switch the model or add a key',
  )
})
