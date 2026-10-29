import { expect, test } from 'bun:test'
import type { AiProviderAllowList } from '@spyria/kernel'
import { BlankProvider, ProviderNotAllowed, UnsupportedProvider } from './errors.ts'
import { newLlmCredential } from './llm-credential.ts'
import { Secret } from './secret.ts'

test('newLlmCredential trims, derives last4 and never carries the secret', () => {
  const credential = newLlmCredential({
    id: 'credential' as never,
    provider: '  OpenAI ',
    secret: new Secret('sk-test-1234567890'),
    allowList: null,
  })
  expect(credential).toMatchObject({ provider: 'OpenAI', gatewayProvider: 'openai', last4: '7890' })
  expect(JSON.stringify(credential)).not.toContain('sk-test')
})

const gatewayProviderOrErrorOf = (provider: string, allowList: AiProviderAllowList | null = null) => {
  try {
    return newLlmCredential({ id: 'credential' as never, provider, secret: new Secret('abcd'), allowList })
      .gatewayProvider
  } catch (error) {
    return error
  }
}

test.each([
  ['Anthropic', 'anthropic'],
  ['mistral', 'mistral'],
  ['Fake', expect.any(UnsupportedProvider)],
  ['OpenRouter', 'openrouter'],
  ['Google', 'gemini'],
  ['Gemini', 'gemini'],
  ['xAI', 'xai'],
  ['DeepSeek', 'deepseek'],
  ['Z.ai', 'zai'],
  [' ', expect.any(BlankProvider)],
  ['Foo', expect.any(UnsupportedProvider)],
])('newLlmCredential maps the provider %p to the gateway, or refuses it', (provider, expected) => {
  expect(gatewayProviderOrErrorOf(provider)).toEqual(expected)
})

test('newLlmCredential refuses a provider the workspace allow-list leaves out, whatever models it allows', () => {
  const allowList = { anthropic: 'all', openai: ['openai/gpt-5'] } as const
  expect(gatewayProviderOrErrorOf('Anthropic', allowList)).toBe('anthropic')
  expect(gatewayProviderOrErrorOf('openai', allowList)).toBe('openai')
  const refusal = gatewayProviderOrErrorOf('Google', allowList)
  expect(refusal).toBeInstanceOf(ProviderNotAllowed)
  expect((refusal as Error).message).toBe('Google Gemini is not allowed in this workspace')
})
