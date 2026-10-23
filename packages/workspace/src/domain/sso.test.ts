import { expect, test } from 'bun:test'
import {
  domainOfEmail,
  entraObjectIdPattern,
  instanceAppFor,
  ssoCanBindByEmail,
  ssoEmailOf,
  ssoSettingsFrom,
  ssoSubjectOf,
} from './sso.ts'

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

test('Entra reads the user principal name before the mail attribute, other presets read only email', () => {
  expect(ssoEmailOf('microsoft', { preferred_username: 'pat@acme.com' })).toBe('pat@acme.com')
  expect(ssoEmailOf('microsoft', { email: 'x@acme.com', preferred_username: 'pat@acme.com' })).toBe('pat@acme.com')
  expect(ssoEmailOf('microsoft', { email: 'pat@acme.com' })).toBe('pat@acme.com')
  expect(ssoEmailOf('oidc', { preferred_username: 'pat@acme.com' })).toBeUndefined()
  expect(domainOfEmail(' Pat@Acme.COM ')).toBe('acme.com')
})

test('the app of this Spyria serves Google and Microsoft once configured, never another provider', () => {
  const google = { clientId: 'spyria-google', clientSecret: 'secret' }
  expect(instanceAppFor({ google }, 'google')).toBe(google)
  expect(() => instanceAppFor({ google }, 'microsoft')).toThrow(
    'This Spyria has no Microsoft app: enter the client id and secret of your own',
  )
  expect(() => instanceAppFor({ google }, 'oidc')).toThrow(
    'Only Google Workspace and Microsoft Entra sign in through the app of this Spyria',
  )
})

test('through Google, only a verified email of an account managed by the Google Workspace of its domain signs in', () => {
  const verified = { email: 'pat@acme.com', email_verified: true, hd: 'acme.com' }
  expect(ssoEmailOf('google', verified)).toBe('pat@acme.com')
  expect(ssoEmailOf('google', { ...verified, email_verified: false })).toBeUndefined()
  expect(ssoEmailOf('google', { email: 'pat@acme.com', hd: 'acme.com' })).toBeUndefined()
  expect(ssoEmailOf('google', { ...verified, hd: undefined })).toBeUndefined()
  expect(ssoEmailOf('google', { ...verified, hd: 'globex.com' })).toBeUndefined()
  expect(ssoEmailOf('google', { ...verified, email: 'pat@gmail.com' })).toBeUndefined()
})

test('an Entra guest, whose identity provider is another tenant, is never bound to a member by email', () => {
  const iss = 'https://login.microsoftonline.com/tenant-1/v2.0'
  expect(ssoCanBindByEmail('microsoft', { iss })).toBe(true)
  expect(ssoCanBindByEmail('microsoft', { iss, idp: iss })).toBe(true)
  expect(ssoCanBindByEmail('microsoft', { iss, idp: 'https://sts.windows.net/tenant-2/' })).toBe(false)
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
