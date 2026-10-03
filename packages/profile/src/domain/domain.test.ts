import { expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { memberId, workspaceId } from '@hq/kernel'
import { DisplayName } from './display-name.ts'
import { BlankDisplayName, BlankProvider, BlankSecret, ToolNotInCatalog } from './errors.ts'
import { newLlmCredential } from './llm-credential.ts'
import { connectTool, disconnectTool, type PersonalConnection } from './personal-connection.ts'
import { Secret } from './secret.ts'

const owner = { workspaceId: workspaceId('acme'), memberId: memberId('alice') }
const catalog = ['GitHub', 'Slack', 'Linear']
const slackNeedingReconnection: PersonalConnection = { ...owner, tool: 'Slack', status: 'Needs reconnection' }

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
  expect(() => new Secret('   ')).toThrow(BlankSecret)
})

test('newLlmCredential trims, derives last4 and never carries the secret', () => {
  const credential = newLlmCredential({
    ...owner,
    id: 'credential' as never,
    provider: '  OpenAI ',
    secret: new Secret('sk-test-1234567890'),
  })
  expect(credential).toMatchObject({ provider: 'OpenAI', last4: '7890' })
  expect(JSON.stringify(credential)).not.toContain('sk-test')
})

test('newLlmCredential rejects a blank provider', () => {
  expect(() =>
    newLlmCredential({
      ...owner,
      id: 'credential' as never,
      provider: ' ',
      secret: new Secret('abcd'),
    }),
  ).toThrow(BlankProvider)
})

test('connectTool adds a Connected tool of the catalog and rejects others', () => {
  expect(connectTool([], owner, 'Linear', catalog)).toEqual([{ ...owner, tool: 'Linear', status: 'Connected' }])
  expect(() => connectTool([], owner, 'Jira', catalog)).toThrow(ToolNotInCatalog)
})

test('disconnectTool removes the tool', () => {
  expect(disconnectTool([slackNeedingReconnection], 'Slack')).toEqual([])
})
