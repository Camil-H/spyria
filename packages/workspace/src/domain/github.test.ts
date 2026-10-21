import { expect, test } from 'bun:test'
import { BranchNotFound, InvalidGitHubSettings, RepositoryNotGranted } from './errors.ts'
import { enteredSecretsOf, existingBranchOf, githubSettingsFrom, repositoryNameOf, workingBranchOf } from './github.ts'

test('GitHub settings need a numeric App id and a client id; only entered secrets are kept', () => {
  expect(githubSettingsFrom({ appId: ' 4242 ', clientId: ' Iv1.abc ' })).toEqual({ appId: '4242', clientId: 'Iv1.abc' })
  expect(() => githubSettingsFrom({ appId: 'spyria-app', clientId: 'Iv1.abc' })).toThrow(InvalidGitHubSettings)
  expect(() => githubSettingsFrom({ appId: '4242', clientId: ' ' })).toThrow(InvalidGitHubSettings)
  expect(
    enteredSecretsOf({ appId: '1', clientId: 'c', clientSecret: ' s ', privateKey: '', webhookSecret: '  ' }),
  ).toEqual({
    clientSecret: 's',
  })
})

test('a dev chat needs a repository name GitHub can resolve and an existing base branch', () => {
  expect(repositoryNameOf(' acme/app ')).toBe('acme/app')
  expect(repositoryNameOf('acme-corp/app.web_2')).toBe('acme-corp/app.web_2')
  for (const outside of ['acme/../app', 'acme/..', 'acme', 'acme/app/branches', '../app', 'acme/app?x=1'])
    expect(() => repositoryNameOf(outside)).toThrow(new RepositoryNotGranted(outside))
  expect(() => repositoryNameOf(' ')).toThrow(new RepositoryNotGranted('The repository'))
  expect(existingBranchOf('acme/app', ['main', 'release'], 'release ')).toBe('release')
  expect(() => existingBranchOf('acme/app', ['main'], 'gone')).toThrow(new BranchNotFound('acme/app', 'gone'))
})

test('the working branch is spyria/<chat slug>-<short id>', () => {
  expect(workingBranchOf('Fix the invoice totals!', '1a2b3c4d-5e6f')).toBe('spyria/fix-the-invoice-totals-1a2b3c')
  expect(workingBranchOf('Été café', 'abcdef12')).toBe('spyria/ete-cafe-abcdef')
  expect(workingBranchOf('***', 'abcdef12')).toBe('spyria/chat-abcdef')
  expect(workingBranchOf('a'.repeat(60), 'abcdef12')).toBe(`spyria/${'a'.repeat(40)}-abcdef`)
})
