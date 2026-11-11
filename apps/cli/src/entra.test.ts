import { expect, test } from 'bun:test'
import { type AzRunner, registerEntraApp } from './entra.ts'

const fakeAz =
  (calls: string[][], { failing, registered = '' }: { failing?: string; registered?: string } = {}): AzRunner =>
  (azArguments) => {
    calls.push(azArguments)
    const command = azArguments.slice(0, 3).join(' ')
    if (command === failing) return { exitCode: 1, output: 'Insufficient privileges to complete the operation.' }
    if (command.startsWith('account show')) return { exitCode: 0, output: 'tenant-1' }
    if (command === 'ad app list') return { exitCode: 0, output: registered }
    if (command === 'ad app create') return { exitCode: 0, output: 'client-1' }
    if (command === 'ad sp create') return { exitCode: 0, output: 'sp-1' }
    return { exitCode: 0, output: 'secret-1' }
  }

test('az registers a tenant-only app for a workspace with the redirect URI, its enterprise app and a two-year secret', () => {
  const calls: string[][] = []
  expect(registerEntraApp({ origin: 'https://spyria.example.com', audience: 'tenant' }, fakeAz(calls))).toEqual({
    name: 'Spyria spyria.example.com workspace',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
  })
  expect(calls[1]).toEqual([
    ...['ad', 'app', 'list', '--filter', "displayName eq 'Spyria spyria.example.com workspace'"],
    ...['--query', '[].appId', '-o', 'tsv'],
  ])
  expect(calls[2]).toEqual([
    ...['ad', 'app', 'create', '--display-name', 'Spyria spyria.example.com workspace'],
    ...['--sign-in-audience', 'AzureADMyOrg'],
    ...['--web-redirect-uris', 'https://spyria.example.com/auth/callback', '--query', 'appId', '-o', 'tsv'],
  ])
  expect(calls[3]?.slice(0, 5)).toEqual(['ad', 'sp', 'create', '--id', 'client-1'])
  expect(calls[4]).toContain('--years')
})

test('an app of the same name an earlier setup registered is reused as it is, the one this install holds first: no other app and no other secret', () => {
  const calls: string[][] = []
  const az = fakeAz(calls, { registered: 'client-0\nclient-9' })
  const origin = 'https://spyria.example.com'
  expect(registerEntraApp({ origin, audience: 'any-account' }, az)).toEqual({
    name: 'Spyria spyria.example.com',
    tenantId: 'tenant-1',
    clientId: 'client-0',
    clientSecret: undefined,
  })
  expect(registerEntraApp({ origin, audience: 'any-account', savedClientId: 'client-9' }, az).clientId).toBe('client-9')
  expect(calls.map((call) => call.slice(0, 3).join(' '))).toEqual([
    'account show --query',
    'ad app list',
    'account show --query',
    'ad app list',
  ])
})

test('the account app of this Spyria serves work or school accounts of any directory and personal Microsoft accounts, and an az refusal says which step failed', () => {
  const calls: string[][] = []
  registerEntraApp({ origin: 'https://spyria.example.com', audience: 'any-account' }, fakeAz(calls))
  expect(calls[2]?.join(' ')).toContain(
    '--sign-in-audience AzureADandPersonalMicrosoftAccount --requested-access-token-version 2',
  )
  expect(() =>
    registerEntraApp(
      { origin: 'https://spyria.example.com', audience: 'tenant' },
      fakeAz([], { failing: 'ad app create' }),
    ),
  ).toThrow('az ad app create failed: Insufficient privileges to complete the operation.')
})
