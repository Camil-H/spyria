import { expect, test } from 'bun:test'
import { workspaceId } from '@spyria/kernel'
import {
  ClaimableDomain,
  hasVerificationRecord,
  requireInvitable,
  requireOwnAddressInside,
  requireWorkspaceCreation,
  verificationRecordOf,
} from './domain-claim.ts'

const acme = workspaceId('workspace-acme')
const globex = workspaceId('workspace-globex')

test('a claimable domain is lowercased, loses a leading @ and a trailing dot', () => {
  expect(ClaimableDomain(' @Acme.COM. ')).toBe('acme.com')
  expect(ClaimableDomain('eu.acme.co.uk')).toBe('eu.acme.co.uk')
  expect(ClaimableDomain('xn--bcher-kva.example')).toBe('xn--bcher-kva.example')
})

test.each([
  ['localhost'],
  [''],
  ['acme..com'],
  ['-acme.com'],
  ['acme-.com'],
  ['acme.com/path'],
  ['alice@acme.com'],
  ['acme com'],
  [`${'a'.repeat(64)}.com`],
  [`${'a.'.repeat(127)}com`],
])('%p is not a claimable domain', (text) => {
  expect(() => ClaimableDomain(text)).toThrow('is not a domain name')
})

test('the verification record is found among TXT records, split into chunks or not', () => {
  expect(verificationRecordOf('token-1')).toBe('spyria-verify=token-1')
  expect(hasVerificationRecord([['v=spf1 -all'], ['spyria-verify=', 'token-1']], 'token-1')).toBe(true)
  expect(hasVerificationRecord([['spyria-verify=token-1']], 'token-1')).toBe(true)
  expect(hasVerificationRecord([['spyria-verify=token-2']], 'token-1')).toBe(false)
  expect(hasVerificationRecord([['spyria-verify=token-10']], 'token-1')).toBe(false)
  expect(hasVerificationRecord([], 'token-1')).toBe(false)
})

test('an address at a domain claimed by another workspace cannot be invited', () => {
  expect(() => requireInvitable(acme, 'bob@globex.com', { claimingWorkspaceId: globex, workspaceDomains: [] })).toThrow(
    'globex.com belongs to another workspace',
  )
})

test('a workspace with claimed domains invites only addresses at them', () => {
  const claims = { claimingWorkspaceId: undefined, workspaceDomains: ['acme.com', 'acme.fr'] }
  expect(() => requireInvitable(acme, 'carol@gmail.com', claims)).toThrow('carol@gmail.com is not one of them')
  expect(() => requireInvitable(acme, 'dan@acme.fr', { ...claims, claimingWorkspaceId: acme })).not.toThrow()
})

test('a workspace without claims invites any address at an unclaimed domain', () => {
  expect(() => requireInvitable(acme, 'carol@gmail.com', { workspaceDomains: [] })).not.toThrow()
})

test("an Admin's change keeps their own address inside the claimed domains, or no domain claimed at all", () => {
  expect(() => requireOwnAddressInside('alice@acme.com', ['acme.fr'])).toThrow('at acme.com')
  expect(() => requireOwnAddressInside('alice@acme.com', ['acme.fr', 'acme.com'])).not.toThrow()
  expect(() => requireOwnAddressInside('alice@acme.com', [])).not.toThrow()
})

test('only an account session creates a workspace', () => {
  expect(() => requireWorkspaceCreation('account')).not.toThrow()
  expect(() => requireWorkspaceCreation('workspace sso')).toThrow(
    "Your organization's sign-in opens only its workspace",
  )
  expect(() => requireWorkspaceCreation('claimed domain')).toThrow("belongs to your organization's workspace")
})
