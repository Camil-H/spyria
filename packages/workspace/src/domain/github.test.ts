import { expect, test } from 'bun:test'
import { BranchNotFound, InvalidGitHubSettings, RepositoryNotGranted } from './errors.ts'
import {
  enteredSecretsOf,
  existingBranchOf,
  githubSettingsFrom,
  grantedRepositoryOf,
  workingBranchOf,
} from './github.ts'

test('GitHub settings need a numeric App id and a client id; only entered secrets are kept', () => {
  expect(githubSettingsFrom({ appId: ' 4242 ', clientId: ' Iv1.abc ' })).toEqual({ appId: '4242', clientId: 'Iv1.abc' })
  expect(() => githubSettingsFrom({ appId: 'hq-app', clientId: 'Iv1.abc' })).toThrow(InvalidGitHubSettings)
  expect(() => githubSettingsFrom({ appId: '4242', clientId: ' ' })).toThrow(InvalidGitHubSettings)
  expect(
    enteredSecretsOf({ appId: '1', clientId: 'c', clientSecret: ' s ', privateKey: '', webhookSecret: '  ' }),
  ).toEqual({
    clientSecret: 's',
  })
})

test('a dev chat needs a granted repository and an existing base branch', () => {
  const repository = { fullName: 'acme/app', defaultBranch: 'main' }
  const repositories = [repository]
  expect(grantedRepositoryOf(repositories, ' acme/app ')).toEqual(repository)
  expect(() => grantedRepositoryOf(repositories, 'acme/secret')).toThrow(new RepositoryNotGranted('acme/secret'))
  expect(existingBranchOf('acme/app', ['main', 'release'], 'release ')).toBe('release')
  expect(() => existingBranchOf('acme/app', ['main'], 'gone')).toThrow(new BranchNotFound('acme/app', 'gone'))
})

test('the working branch is hq/<chat slug>-<short id>', () => {
  expect(workingBranchOf('Fix the invoice totals!', '1a2b3c4d-5e6f')).toBe('hq/fix-the-invoice-totals-1a2b3c')
  expect(workingBranchOf('Été café', 'abcdef12')).toBe('hq/ete-cafe-abcdef')
  expect(workingBranchOf('***', 'abcdef12')).toBe('hq/chat-abcdef')
  expect(workingBranchOf('a'.repeat(60), 'abcdef12')).toBe(`hq/${'a'.repeat(40)}-abcdef`)
})
