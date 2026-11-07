import { expect, test } from 'bun:test'
import { type AzRunner, registerEntraApp } from './entra.ts'

const fakeAz =
  (calls: string[][], failing?: string): AzRunner =>
  (azArguments) => {
    calls.push(azArguments)
    const command = azArguments.slice(0, 3).join(' ')
    if (command === failing) return { exitCode: 1, output: 'Insufficient privileges to complete the operation.' }
    if (command.startsWith('account show')) return { exitCode: 0, output: 'tenant-1' }
    if (command === 'ad app create') return { exitCode: 0, output: 'client-1' }
    if (command === 'ad sp create') return { exitCode: 0, output: 'sp-1' }
    return { exitCode: 0, output: 'secret-1' }
  }

test('az registers a tenant-only app for a workspace with the redirect URI, its enterprise app and a two-year secret', () => {
  const calls: string[][] = []
  expect(registerEntraApp({ origin: 'https://spyria.example.com', audience: 'tenant' }, fakeAz(calls))).toEqual({
    tenantId: 'tenant-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
  })
  expect(calls[1]).toEqual([
    ...['ad', 'app', 'create', '--display-name', 'Spyria spyria.example.com', '--sign-in-audience', 'AzureADMyOrg'],
    ...['--web-redirect-uris', 'https://spyria.example.com/auth/callback', '--query', 'appId', '-o', 'tsv'],
  ])
  expect(calls[2]?.slice(0, 5)).toEqual(['ad', 'sp', 'create', '--id', 'client-1'])
  expect(calls[3]).toContain('--years')
})

test('the app of this Spyria serves every organizational directory, and an az refusal says which step failed', () => {
  const calls: string[][] = []
  registerEntraApp({ origin: 'https://spyria.example.com', audience: 'organizations' }, fakeAz(calls))
  expect(calls[1]).toContain('AzureADMultipleOrgs')
  expect(() =>
    registerEntraApp({ origin: 'https://spyria.example.com', audience: 'tenant' }, fakeAz([], 'ad app create')),
  ).toThrow('az ad app create failed: Insufficient privileges to complete the operation.')
})
