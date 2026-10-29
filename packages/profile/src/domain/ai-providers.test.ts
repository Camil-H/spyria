import { expect, test } from 'bun:test'
import { aiProviders } from '@spyria/kernel'
import { allowListSummaryOf, checkedAllowList, withModels, withProvider } from './ai-providers.ts'
import { ModelOfAnotherProvider, UnsupportedProvider } from './errors.ts'

const errorOf = (work: () => unknown) => {
  try {
    return work()
  } catch (error) {
    return error
  }
}

test('turning a provider off starts from every provider, and turning it back on allows all its models', () => {
  const withoutMistral = withProvider(null, 'mistral', false)
  expect(Object.keys(withoutMistral)).toEqual(aiProviders.map(({ id }) => id).filter((id) => id !== 'mistral'))
  expect(withProvider(withoutMistral, 'mistral', true).mistral).toBe('all')
  expect(withModels({ openai: 'all' }, 'openai', ['openai/gpt-5'])).toEqual({ openai: ['openai/gpt-5'] })
})

test('a saved allow-list drops providers left without models and refuses unknown providers and foreign models', () => {
  expect(checkedAllowList(null)).toBeNull()
  expect(checkedAllowList({ openai: [], anthropic: 'all' })).toEqual({ anthropic: 'all' })
  expect(errorOf(() => checkedAllowList({ fake: 'all' }))).toBeInstanceOf(UnsupportedProvider)
  const foreign = errorOf(() => checkedAllowList({ openai: ['anthropic/claude-opus-5-5'] }))
  expect(foreign).toBeInstanceOf(ModelOfAnotherProvider)
  expect((foreign as Error).message).toBe('anthropic/claude-opus-5-5 is not a model of OpenAI')
})

test('the audit summary names providers and their chosen models in plain words', () => {
  expect(allowListSummaryOf(null)).toEqual(['Every provider and model'])
  expect(allowListSummaryOf({ anthropic: 'all', openai: ['openai/gpt-5', 'openai/gpt-x'] })).toEqual([
    'Anthropic',
    'OpenAI (GPT-5, openai/gpt-x)',
  ])
})
