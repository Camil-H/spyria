import { expect, test } from 'bun:test'
import {
  accountIssuerOf,
  accountProvidersOf,
  entraObjectIdPattern,
  instanceAppFor,
  microsoftPersonalAccountsTenantId,
  ssoCanBindByEmail,
  ssoEmailOf,
  ssoSettingsFrom,
  ssoSubjectOf,
} from './sso.ts'

const base = { clientId: ' spyria ' }

test('presets give the issuer', () => {
  expect(ssoSettingsFrom({ ...base, preset: 'google' })).toEqual({
    preset: 'google',
    issuer: 'https://accounts.google.com',
    clientId: 'spyria',
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
] as const)('refuses %o', (input, message) => {
  expect(() => ssoSettingsFrom({ ...base, ...input } as Parameters<typeof ssoSettingsFrom>[0])).toThrow(message)
})

test('Entra reads the user principal name before the mail attribute, which an account never falls back to; other presets read only a confirmed email', () => {
  expect(ssoEmailOf('microsoft', { preferred_username: 'pat@acme.com' }, 'workspace')).toEqual({
    email: 'pat@acme.com',
  })
  expect(ssoEmailOf('microsoft', { email: 'x@acme.com', preferred_username: 'pat@acme.com' }, 'account')).toEqual({
    email: 'pat@acme.com',
  })
  expect(ssoEmailOf('microsoft', { email: 'pat@acme.com' }, 'workspace')).toEqual({ email: 'pat@acme.com' })
  expect(ssoEmailOf('microsoft', { email: 'pat@acme.com' }, 'account')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('microsoft', {}, 'account')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('oidc', { preferred_username: 'pat@acme.com', email_verified: true }, 'workspace')).toEqual({
    refusal: 'untrusted',
  })
  expect(ssoEmailOf('oidc', { email: 'pat@acme.com', email_verified: true }, 'workspace')).toEqual({
    email: 'pat@acme.com',
  })
  expect(ssoEmailOf('oidc', { email: 'pat@acme.com' }, 'workspace')).toEqual({ refusal: 'unconfirmed' })
  expect(ssoEmailOf('oidc', { email: 'pat@acme.com', email_verified: false }, 'account')).toEqual({
    refusal: 'unconfirmed',
  })
})

test('the app of this Spyria serves Google and Microsoft once configured, never another provider', () => {
  const google = { clientId: 'spyria-google', clientSecret: 'secret' }
  expect(instanceAppFor({ google }, 'google')).toBe(google)
  expect(() => instanceAppFor({ google }, 'microsoft')).toThrow(
    'This Spyria has no Microsoft app: enter the client id and secret of your own',
  )
  expect(() => instanceAppFor({ google, oidc: { ...google, issuer: 'https://idp.acme.com' } }, 'oidc')).toThrow(
    'Only Google Workspace and Microsoft Entra sign in through the app of this Spyria',
  )
})

test('accounts sign in through the configured apps of this Spyria; Microsoft takes any tenant and personal accounts', () => {
  const app = { clientId: 'spyria', clientSecret: 'secret' }
  expect(accountProvidersOf({})).toEqual([])
  expect(accountProvidersOf({ microsoft: app, oidc: { ...app, issuer: 'https://idp.acme.com/' } })).toEqual([
    'microsoft',
    'oidc',
  ])
  const apps = { oidc: { ...app, issuer: 'https://idp.acme.com/' } }
  expect(accountIssuerOf('google', apps)).toBe('https://accounts.google.com')
  expect(accountIssuerOf('microsoft', apps)).toBe('https://login.microsoftonline.com/common/v2.0')
  expect(accountIssuerOf('microsoft', apps, 'http://localhost:9')).toBe('http://localhost:9/common/v2.0')
  expect(accountIssuerOf('oidc', apps)).toBe('https://idp.acme.com')
})

test("through Google, a workspace's own sign-in takes only a confirmed account managed by the Google Workspace of its address", () => {
  const verified = { email: 'pat@acme.com', email_verified: true, hd: 'acme.com' }
  expect(ssoEmailOf('google', verified, 'workspace')).toEqual({ email: 'pat@acme.com' })
  expect(ssoEmailOf('google', { ...verified, email_verified: false }, 'workspace')).toEqual({ refusal: 'unconfirmed' })
  expect(ssoEmailOf('google', { email: 'pat@acme.com', hd: 'acme.com' }, 'workspace')).toEqual({
    refusal: 'unconfirmed',
  })
  expect(ssoEmailOf('google', { ...verified, hd: undefined }, 'workspace')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('google', { ...verified, hd: 'globex.com' }, 'workspace')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('google', { ...verified, email: 'pat@gmail.com' }, 'workspace')).toEqual({ refusal: 'untrusted' })
})

test('through Google, an account takes any confirmed address, Gmail included', () => {
  expect(ssoEmailOf('google', { email: 'pat@gmail.com', email_verified: true }, 'account')).toEqual({
    email: 'pat@gmail.com',
  })
  expect(ssoEmailOf('google', { email: 'pat@acme.com', email_verified: true, hd: 'acme.com' }, 'account')).toEqual({
    email: 'pat@acme.com',
  })
  expect(ssoEmailOf('google', { email: 'pat@gmail.com', email_verified: false }, 'account')).toEqual({
    refusal: 'unconfirmed',
  })
})

test('an Entra guest, whose identity provider is another tenant, is never bound by email; a personal account is', () => {
  const iss = 'https://login.microsoftonline.com/tenant-1/v2.0'
  expect(ssoCanBindByEmail('microsoft', { iss })).toBe(true)
  expect(ssoCanBindByEmail('microsoft', { iss, idp: iss })).toBe(true)
  expect(ssoCanBindByEmail('microsoft', { iss, idp: 'https://sts.windows.net/tenant-2/' })).toBe(false)
  expect(ssoCanBindByEmail('microsoft', { iss, idp: 'live.com', tid: microsoftPersonalAccountsTenantId })).toBe(true)
  expect(ssoCanBindByEmail('oidc', { iss, idp: 'elsewhere' })).toBe(true)
})

test('an Entra object id has the GUID form, a per-app subject does not', () => {
  const objectId = new RegExp(entraObjectIdPattern)
  expect(objectId.test('00000000-0000-4000-8000-000000000001')).toBe(true)
  expect(objectId.test('AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ')).toBe(false)
})

test('an Entra identity is its object id, the same through every app of the tenant; other providers use the subject', () => {
  expect(ssoSubjectOf('microsoft', { sub: 'per-app', oid: 'object-1' })).toBe('object-1')
  expect(ssoSubjectOf('microsoft', { sub: 'per-app' })).toBeUndefined()
  expect(ssoSubjectOf('google', { sub: 'google-1', oid: 'ignored' })).toBe('google-1')
  expect(ssoSubjectOf('oidc', {})).toBeUndefined()
})
