import { expect, test } from 'bun:test'
import { JoinBySettingInvalid } from './errors.ts'
import {
  domainOfEmail,
  entraObjectIdPattern,
  instanceAppFor,
  isPublicEmailDomain,
  joinByOf,
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
  expect(ssoSettingsFrom({ ...base, preset: 'microsoft', tenantId: 't' }, 'domain', 'http://localhost:9').issuer).toBe(
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
  [{ preset: 'google', domain: 'Gmail.com' }, 'gmail.com is a public email domain'],
] as const)('refuses %o', (input, message) => {
  expect(() => ssoSettingsFrom({ ...base, ...input } as Parameters<typeof ssoSettingsFrom>[0])).toThrow(message)
})

test('a workspace joined by invited address owns no domain: none is required and one is refused', () => {
  expect(ssoSettingsFrom({ ...base, domain: undefined, preset: 'google' }, 'invited_address')).toEqual({
    preset: 'google',
    issuer: 'https://accounts.google.com',
    clientId: 'spyria',
    domain: null,
  })
  expect(
    ssoSettingsFrom({ ...base, domain: ' ', preset: 'oidc', issuer: 'https://idp.x.com' }, 'invited_address').domain,
  ).toBeNull()
  expect(() => ssoSettingsFrom({ ...base, preset: 'google' }, 'invited_address')).toThrow(
    'A workspace joined by invited address owns no email domain',
  )
  expect(() => ssoSettingsFrom({ ...base, preset: 'microsoft', tenantId: 'common' }, 'invited_address')).toThrow(
    'Only a tenant-specific Microsoft Entra issuer is accepted',
  )
})

test('the instance setting names how people join, with domain as the default', () => {
  expect(joinByOf(undefined)).toBe('domain')
  expect(joinByOf('')).toBe('domain')
  expect(joinByOf('domain')).toBe('domain')
  expect(joinByOf('invited-address')).toBe('invited_address')
  expect(() => joinByOf('anyone')).toThrow(JoinBySettingInvalid)
  expect(isPublicEmailDomain('outlook.com')).toBe(true)
  expect(isPublicEmailDomain('acme.com')).toBe(false)
})

test('Entra reads the user principal name before the mail attribute; other presets read only a confirmed email', () => {
  expect(ssoEmailOf('microsoft', { preferred_username: 'pat@acme.com' }, 'domain')).toEqual({ email: 'pat@acme.com' })
  expect(ssoEmailOf('microsoft', { email: 'x@acme.com', preferred_username: 'pat@acme.com' }, 'domain')).toEqual({
    email: 'pat@acme.com',
  })
  expect(ssoEmailOf('microsoft', { email: 'pat@acme.com' }, 'domain')).toEqual({ email: 'pat@acme.com' })
  expect(ssoEmailOf('microsoft', {}, 'domain')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('oidc', { preferred_username: 'pat@acme.com', email_verified: true }, 'domain')).toEqual({
    refusal: 'untrusted',
  })
  expect(ssoEmailOf('oidc', { email: 'pat@acme.com', email_verified: true }, 'domain')).toEqual({
    email: 'pat@acme.com',
  })
  expect(ssoEmailOf('oidc', { email: 'pat@acme.com' }, 'domain')).toEqual({ refusal: 'unconfirmed' })
  expect(ssoEmailOf('oidc', { email: 'pat@acme.com', email_verified: false }, 'invited_address')).toEqual({
    refusal: 'unconfirmed',
  })
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

test('through Google, a by-domain workspace takes only a confirmed account managed by the Google Workspace of its domain', () => {
  const verified = { email: 'pat@acme.com', email_verified: true, hd: 'acme.com' }
  expect(ssoEmailOf('google', verified, 'domain')).toEqual({ email: 'pat@acme.com' })
  expect(ssoEmailOf('google', { ...verified, email_verified: false }, 'domain')).toEqual({ refusal: 'unconfirmed' })
  expect(ssoEmailOf('google', { email: 'pat@acme.com', hd: 'acme.com' }, 'domain')).toEqual({ refusal: 'unconfirmed' })
  expect(ssoEmailOf('google', { ...verified, hd: undefined }, 'domain')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('google', { ...verified, hd: 'globex.com' }, 'domain')).toEqual({ refusal: 'untrusted' })
  expect(ssoEmailOf('google', { ...verified, email: 'pat@gmail.com' }, 'domain')).toEqual({ refusal: 'untrusted' })
})

test('through Google, a workspace joined by invited address takes any confirmed account, Gmail included', () => {
  expect(ssoEmailOf('google', { email: 'pat@gmail.com', email_verified: true }, 'invited_address')).toEqual({
    email: 'pat@gmail.com',
  })
  expect(
    ssoEmailOf('google', { email: 'pat@acme.com', email_verified: true, hd: 'acme.com' }, 'invited_address'),
  ).toEqual({ email: 'pat@acme.com' })
  expect(ssoEmailOf('google', { email: 'pat@gmail.com', email_verified: false }, 'invited_address')).toEqual({
    refusal: 'unconfirmed',
  })
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
