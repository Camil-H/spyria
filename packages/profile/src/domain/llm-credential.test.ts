import { expect, test } from 'bun:test'
import { memberId, workspaceId } from '@hq/kernel'
import { BlankProvider, UnsupportedProvider } from './errors.ts'
import { gatewayKeyOf, gatewayKeyRefOf, newLlmCredential } from './llm-credential.ts'
import { Secret } from './secret.ts'

const owner = { workspaceId: workspaceId('acme'), memberId: memberId('alice') }

test('newLlmCredential trims, derives last4 and never carries the secret', () => {
  const credential = newLlmCredential({
    ...owner,
    id: 'credential' as never,
    provider: '  OpenAI ',
    secret: new Secret('sk-test-1234567890'),
  })
  expect(credential).toMatchObject({ provider: 'OpenAI', gatewayProvider: 'openai', last4: '7890' })
  expect(JSON.stringify(credential)).not.toContain('sk-test')
})

const gatewayProviderOrErrorOf = (provider: string) => {
  try {
    return newLlmCredential({ ...owner, id: 'credential' as never, provider, secret: new Secret('abcd') })
      .gatewayProvider
  } catch (error) {
    return error
  }
}

test.each([
  ['Anthropic', 'anthropic'],
  ['mistral', 'mistral'],
  ['Fake', 'fake'],
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

test('a gateway key reference round-trips and refuses anything else', () => {
  const key = { provider: 'openai', id: '8ec7907d-bef5-433b-92b8-df18842db1f2' }
  expect(gatewayKeyOf(gatewayKeyRefOf(key))).toEqual(key)
  expect(gatewayKeyOf('gateway:credential-alice-anthropic')).toBeUndefined()
  expect(gatewayKeyOf('placeholder:abc')).toBeUndefined()
})
