import { expect, test } from 'bun:test'
import {
  cheapestModelOf,
  defaultModelOf,
  modelNameOf,
  nearestModelOf,
  providersOfGatewayRefs,
  reachableModelsOf,
  rereadDollarsOf,
} from '@hq/kernel'
import {
  classificationOf,
  classifierRequestOf,
  sessionChoiceOf,
  unreachableSessionNoticeOf,
} from './session-routing.ts'

const fake = reachableModelsOf(['fake'])
const idsOf = (models: { id: string }[]) => models.map((model) => model.id)

test('reachable models follow the providers of the member gateway keys, strongest first', () => {
  expect(providersOfGatewayRefs(['gateway:fake/1', 'gateway:fake-small/2', 'gateway:fake/3', 'legacy'])).toEqual([
    'fake',
    'fake-small',
  ])
  expect(idsOf(fake)).toEqual(['fake/fake-large', 'fake/fake-medium', 'fake/fake-small'])
  expect(idsOf(reachableModelsOf(['fake-small']))).toEqual(['fake-small/fake-small'])
  expect(reachableModelsOf([])).toEqual([])
})

test('the nearest model keeps the tier, then goes below, then above', () => {
  const smallOnly = reachableModelsOf(['fake-small'])
  expect(nearestModelOf(fake, 'large')?.id).toBe('fake/fake-large')
  expect(nearestModelOf(smallOnly, 'large')?.id).toBe('fake-small/fake-small')
  expect(nearestModelOf(smallOnly, 'medium')?.id).toBe('fake-small/fake-small')
  expect(
    nearestModelOf(
      fake.filter((model) => model.tier === 'large'),
      'medium',
    )?.id,
  ).toBe('fake/fake-large')
  expect(defaultModelOf(fake)?.id).toBe('fake/fake-medium')
  expect(defaultModelOf([])).toBeUndefined()
  expect(cheapestModelOf(fake)?.id).toBe('fake/fake-small')
})

test('short names come from the catalog, unknown models keep their name', () => {
  expect(modelNameOf('anthropic/claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(modelNameOf('openai/gpt-5')).toBe('GPT-5')
  expect(modelNameOf('fake/fake-large')).toBe('Fake large')
  expect(modelNameOf('somewhere/other-model')).toBe('other-model')
})

test('the reread estimate uses the conversation tokens and the input price, unknown without either', () => {
  expect(rereadDollarsOf('fake/fake-large', 2_000_000)).toBe(60)
  expect(rereadDollarsOf('fake/fake-large', null)).toBeUndefined()
  expect(rereadDollarsOf('anthropic/claude-opus-5-5', 1000)).toBeUndefined()
})

test('the classifier request asks for the structured output on the given model', () => {
  const request = classifierRequestOf({ model: 'fake/fake-small', message: 'Refactor the billing module', mode: 'dev' })
  expect(request.model).toBe('fake/fake-small')
  expect(request.response_format.type).toBe('json_schema')
  expect(request.response_format.json_schema.schema.required).toEqual(['tier', 'confidence', 'effort', 'reason'])
  expect(JSON.stringify(request.messages)).toContain('Refactor the billing module')
  expect(JSON.stringify(request.messages)).toContain('dev')
})

test('a classification is parsed only when every field is valid', () => {
  const valid = { tier: 'large', confidence: 'high', effort: 'high', reason: 'refactor' } as const
  expect(classificationOf(JSON.stringify(valid))).toEqual(valid)
  expect(classificationOf(JSON.stringify({ ...valid, tier: 'huge' }))).toBeUndefined()
  expect(classificationOf(JSON.stringify({ ...valid, confidence: 0.9 }))).toBeUndefined()
  expect(classificationOf('not json')).toBeUndefined()
  expect(classificationOf(undefined)).toBeUndefined()
})

const classified = (tier: 'large' | 'medium' | 'small', confidence: 'high' | 'low' = 'high') => ({
  tier,
  confidence,
  effort: 'low' as const,
  reason: 'test',
})

test('only a confident large or small classification moves away from the chat default', () => {
  const route = (classification: ReturnType<typeof classified> | undefined, defaultModel = 'fake/fake-medium') =>
    sessionChoiceOf({ reachable: fake, defaultModel, classification })
  expect(route(classified('large'))).toMatchObject({ model: { id: 'fake/fake-large' }, effort: 'low' })
  expect(route(classified('small'))).toMatchObject({ model: { id: 'fake/fake-small' } })
  expect(route(classified('large', 'low'))).toMatchObject({ model: { id: 'fake/fake-medium' }, effort: 'low' })
  expect(route(classified('medium'))?.model.id).toBe('fake/fake-medium')
  expect(route(undefined)).toMatchObject({ model: { id: 'fake/fake-medium' }, effort: 'medium' })
  expect(route(undefined, 'fake/fake-small')?.model.id).toBe('fake/fake-small')
})

test('an unreachable or missing default falls back to the nearest reachable model of its tier', () => {
  const smallOnly = reachableModelsOf(['fake-small'])
  expect(
    sessionChoiceOf({ reachable: fake, defaultModel: 'anthropic/claude-sonnet-5-5', classification: undefined }),
  ).toMatchObject({ model: { id: 'fake/fake-medium' } })
  expect(sessionChoiceOf({ reachable: fake, defaultModel: null, classification: undefined })?.model.id).toBe(
    'fake/fake-medium',
  )
  expect(
    sessionChoiceOf({ reachable: smallOnly, defaultModel: 'fake/fake-medium', classification: classified('large') })
      ?.model.id,
  ).toBe('fake-small/fake-small')
  expect(
    sessionChoiceOf({ reachable: [], defaultModel: 'fake/fake-medium', classification: undefined }),
  ).toBeUndefined()
})

test('a prompter who cannot reach the session model gets the cannot-reach notice', () => {
  expect(unreachableSessionNoticeOf('fake/fake-large')).toBe(
    'Your keys cannot reach Fake large; switch the model or add a key',
  )
})
