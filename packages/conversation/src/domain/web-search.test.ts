import { expect, test } from 'bun:test'
import type { Model } from '@spyria/kernel'
import { webSearchAnswerOf, webSearchModelOf, webSearchQueryOf, webSearchRequestOf } from './web-search.ts'

const model = (id: string, tier: Model['tier']) => ({ id, name: id, tier }) as Model

test('a query is searched as typed, and a blank or overlong one is refused', () => {
  expect(webSearchQueryOf({ query: '  zero sync release notes ' })).toBe('zero sync release notes')
  expect(webSearchQueryOf({ query: ' ' })).toEqual({ refusal: 'Give the words to search for' })
  expect(webSearchQueryOf({})).toEqual({ refusal: 'Give the words to search for' })
  expect(webSearchQueryOf({ query: 'x'.repeat(401) })).toEqual({ refusal: 'The query is longer than 400 characters' })
})

test('the search runs on the cheapest of the prompter’s chat models whose provider searches the web', () => {
  expect(
    webSearchModelOf([
      model('anthropic/claude-opus-5-5', 'large'),
      model('mistral/mistral-small-latest', 'small'),
      model('openai/gpt-5-nano', 'small'),
      model('gemini/gemini-flash-latest', 'medium'),
      model('anthropic/claude-haiku-5-5', 'small'),
    ]),
  ).toBe('anthropic/claude-haiku-5-5')
  expect(webSearchModelOf([model('openai/gpt-5', 'large'), model('openai/gpt-5-mini', 'medium')])).toBe(
    'openai/gpt-5-mini',
  )
  expect(webSearchModelOf([model('mistral/mistral-large-latest', 'large')])).toBeUndefined()
  expect(webSearchModelOf([])).toBeUndefined()
})

test('the search asks the model to use the web search tool of its provider', () => {
  expect(webSearchRequestOf('anthropic/claude-haiku-5-5', 'zero sync')).toMatchObject({
    model: 'anthropic/claude-haiku-5-5',
    input: 'zero sync',
    tools: [{ type: 'web_search' }],
  })
})

test('the answer gives what the results say and their sources once each, cited ones first', () => {
  expect(
    webSearchAnswerOf({
      output: [
        {
          type: 'web_search_call',
          action: {
            sources: [{ url: 'https://zero.rocicorp.dev/docs' }, { url: 'https://example.com/zero', title: 'Zero' }],
          },
        },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'Zero 1.0 shipped in 2026.',
              annotations: [
                { type: 'url_citation', url: 'https://zero.rocicorp.dev/docs', title: 'Zero docs' },
                { type: 'url_citation', url: 'https://zero.rocicorp.dev/docs', title: 'Zero docs' },
              ],
            },
          ],
        },
      ],
    }),
  ).toBe(
    'Zero 1.0 shipped in 2026.\n\nSources:\n- Zero docs: https://zero.rocicorp.dev/docs\n- Zero: https://example.com/zero',
  )
})

test('an answer without a search is told apart, and a search without text still answers', () => {
  expect(
    webSearchAnswerOf({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'From memory' }] }] }),
  ).toBeUndefined()
  expect(webSearchAnswerOf({})).toBeUndefined()
  expect(webSearchAnswerOf({ output: [{ type: 'web_search_call' }] })).toBe('The search found nothing to say.')
})
