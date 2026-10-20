import { expect, test } from 'bun:test'
import { domainOfEmail, ssoEmailOf, ssoSettingsFrom } from './sso.ts'

const base = { clientId: ' spyria ', domain: ' @Acme.com' }

test('presets give the issuer, and the domain is normalized', () => {
  expect(ssoSettingsFrom({ ...base, preset: 'google' })).toEqual({
    preset: 'google',
    issuer: 'https://accounts.google.com',
    clientId: 'spyria',
    domain: 'acme.com',
  })
  expect(ssoSettingsFrom({ ...base, preset: 'microsoft', tenantId: 'tenant-1' }).issuer).toBe(
    'https://login.microsoftonline.com/tenant-1/v2.0',
  )
  expect(ssoSettingsFrom({ ...base, preset: 'microsoft', tenantId: 't' }, 'http://localhost:9').issuer).toBe(
    'http://localhost:9/t/v2.0',
  )
  expect(ssoSettingsFrom({ ...base, preset: 'oidc', issuer: 'https://idp.acme.com/' }).issuer).toBe(
    'https://idp.acme.com',
  )
})

test.each([
  [{ preset: 'microsoft', tenantId: 'common' }, 'Only a tenant-specific Microsoft Entra issuer is accepted'],
  [{ preset: 'microsoft', tenantId: 'Organizations' }, 'Only a tenant-specific Microsoft Entra issuer is accepted'],
  [
    { preset: 'oidc', issuer: 'https://login.microsoftonline.com/common/v2.0' },
    'Only a tenant-specific Microsoft Entra issuer is accepted',
  ],
  [{ preset: 'microsoft', tenantId: '' }, 'A Microsoft Entra tenant id is required'],
  [{ preset: 'oidc', issuer: 'not a url' }, 'The issuer must be a URL'],
  [{ preset: 'oidc', issuer: 'https://idp.acme.com', clientId: ' ' }, 'A client id is required'],
  [{ preset: 'google', domain: ' ' }, 'An email domain is required'],
  [{ preset: 'google', domain: 'acme' }, 'acme is not an email domain'],
] as const)('refuses %o', (input, message) => {
  expect(() => ssoSettingsFrom({ ...base, ...input } as Parameters<typeof ssoSettingsFrom>[0])).toThrow(message)
})

test('Entra falls back to preferred_username, other presets read only email', () => {
  expect(ssoEmailOf('microsoft', { preferred_username: 'pat@acme.com' })).toBe('pat@acme.com')
  expect(ssoEmailOf('microsoft', { email: 'pat@acme.com', preferred_username: 'x@acme.com' })).toBe('pat@acme.com')
  expect(ssoEmailOf('oidc', { preferred_username: 'pat@acme.com' })).toBeUndefined()
  expect(domainOfEmail(' Pat@Acme.COM ')).toBe('acme.com')
})
