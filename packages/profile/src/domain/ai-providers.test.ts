import { expect, test } from 'bun:test'
import { aiProviders } from '@spyria/kernel'
import { allowListSummaryOf, checkedAllowList, withProvider } from './ai-providers.ts'
import { UnsupportedProvider } from './errors.ts'

test('turning a provider off starts from every provider, and turning it back on allows it again', () => {
  const withoutMistral = withProvider(null, 'mistral', false)
  expect(withoutMistral).toEqual(aiProviders.map(({ id }) => id).filter((id) => id !== 'mistral'))
  expect(withProvider(withoutMistral, 'mistral', true)).toContain('mistral')
  expect(withProvider(['openai'], 'openai', true)).toEqual(['openai'])
})

test('a saved allow-list keeps known providers once, in catalog order, and refuses an unknown one', () => {
  expect(checkedAllowList(null)).toBeNull()
  expect(checkedAllowList(['mistral', 'anthropic', 'mistral'])).toEqual(['anthropic', 'mistral'])
  expect(checkedAllowList([])).toEqual([])
  expect(() => checkedAllowList(['fake'])).toThrow(UnsupportedProvider)
})

test('the audit summary names the allowed providers in plain words', () => {
  expect(allowListSummaryOf(null)).toEqual(['Every provider'])
  expect(allowListSummaryOf(['anthropic', 'gemini'])).toEqual(['Anthropic', 'Google Gemini'])
})
