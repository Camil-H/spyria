import { expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { memberId, workspaceId } from '@hq/kernel'
import { DisplayName } from './display-name.ts'
import { BlankDisplayName, BlankProvider, BlankSecret, ToolNotInCatalog, UnsupportedProvider } from './errors.ts'
import { gatewayKeyOf, gatewayKeyRefOf, newLlmCredential } from './llm-credential.ts'
import { connectedTool } from './personal-connection.ts'
import { Secret } from './secret.ts'

const owner = { workspaceId: workspaceId('acme'), memberId: memberId('alice') }
const catalog = ['GitHub', 'Slack', 'Linear']

test('DisplayName trims and rejects blank values', () => {
  expect(String(DisplayName('  Alice D.  '))).toBe('Alice D.')
  expect(() => DisplayName('  ')).toThrow(BlankDisplayName)
})

test('Secret redacts itself in text, JSON and inspection', () => {
  const secret = new Secret('sk-test-1234567890')
  expect(String(secret)).not.toContain('1234')
  expect(`${secret}`).not.toContain('1234')
  expect(JSON.stringify({ secret })).not.toContain('1234')
  expect(inspect(secret)).not.toContain('1234')
  expect(inspect({ nested: [secret] })).not.toContain('1234')
})

test('last4 derives the last four characters and Secret rejects blank values', () => {
  expect(new Secret('sk-test-1234567890').last4()).toBe('7890')
  expect(new Secret('sk-test-1234567890').reveal()).toBe('sk-test-1234567890')
  expect(() => new Secret('   ')).toThrow(BlankSecret)
})

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

test('connectedTool connects a tool of the catalog and rejects others', () => {
  expect(connectedTool(owner, 'Linear', catalog)).toEqual({ ...owner, tool: 'Linear', status: 'Connected' })
  expect(() => connectedTool(owner, 'Jira', catalog)).toThrow(ToolNotInCatalog)
})
