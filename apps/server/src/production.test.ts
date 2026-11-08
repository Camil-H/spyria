import { expect, test } from 'bun:test'
import { productionProblemsOf } from './production.ts'

const production = {
  SPYRIA_ENV: 'production',
  SPYRIA_AUTH_MODE: 'sso',
  SPYRIA_TOKEN_SECRET: 'a'.repeat(64),
  SPYRIA_SECRETS_KEY: 'b'.repeat(64),
  SPYRIA_SETUP_TOKEN: 'd'.repeat(48),
  SPYRIA_APP_ORIGIN: 'https://spyria.example',
  SPYRIA_OIDC_REDIRECT_URI: 'https://spyria.example/auth/callback',
  SPYRIA_SMTP_URL: 'smtp://user:pass@smtp.example:587',
  SPYRIA_MAIL_FROM: 'Spyria <spyria@spyria.example>',
  SPYRIA_GATEWAY_URL: 'http://gateway:8080',
  SPYRIA_GATEWAY_ADMIN_USER: 'gateway-admin',
  SPYRIA_GATEWAY_ADMIN_PASSWORD: 'c'.repeat(40),
}
const problemsWith = (changes: Record<string, string | undefined>) =>
  productionProblemsOf({ ...production, ...changes })

test('a correct production environment and development pass', () => {
  expect(productionProblemsOf(production)).toEqual([])
  expect(productionProblemsOf({ ...production, SPYRIA_ENV: undefined, SPYRIA_AUTH_MODE: 'dex' })).toEqual([])
  expect(productionProblemsOf({})).toEqual([])
})

test('SPYRIA_ENV is unset or production', () => {
  expect(problemsWith({ SPYRIA_ENV: 'staging' })).toEqual([
    'SPYRIA_ENV must be unset (development) or production, not staging.',
  ])
})

test('the auth mode is sso', () => {
  expect(problemsWith({ SPYRIA_AUTH_MODE: 'dex' })).toEqual(['SPYRIA_AUTH_MODE must be sso.'])
  expect(problemsWith({ SPYRIA_AUTH_MODE: undefined })).toEqual(['SPYRIA_AUTH_MODE must be sso.'])
})

test.each(['SPYRIA_TOKEN_SECRET', 'SPYRIA_SECRETS_KEY', 'SPYRIA_SETUP_TOKEN'])(
  '%s is present, long enough and not a dev default',
  (name) => {
    expect(problemsWith({ [name]: undefined })).toEqual([`${name} is required.`])
    expect(problemsWith({ [name]: 'x'.repeat(31) })).toEqual([`${name} must be at least 32 characters.`])
    expect(problemsWith({ [name]: 'spyria-dev-gateway-encryption-key' })).toEqual([
      `${name} must not be a development default.`,
    ])
  },
)

test('the app origin is https and the OIDC redirect is on it', () => {
  expect(
    problemsWith({ SPYRIA_APP_ORIGIN: 'http://spyria.example', SPYRIA_OIDC_REDIRECT_URI: 'http://spyria.example/cb' }),
  ).toEqual(['SPYRIA_APP_ORIGIN must start with https://.'])
  expect(problemsWith({ SPYRIA_OIDC_REDIRECT_URI: 'https://other.example/auth/callback' })).toEqual([
    'SPYRIA_OIDC_REDIRECT_URI must be on SPYRIA_APP_ORIGIN.',
  ])
  expect(problemsWith({ SPYRIA_OIDC_REDIRECT_URI: undefined })).toEqual([
    'SPYRIA_OIDC_REDIRECT_URI must be on SPYRIA_APP_ORIGIN.',
  ])
})

test('mail is optional, but a sender is required once SMTP is set', () => {
  expect(problemsWith({ SPYRIA_SMTP_URL: undefined, SPYRIA_MAIL_FROM: undefined })).toEqual([])
  expect(problemsWith({ SPYRIA_MAIL_FROM: undefined })).toEqual(['SPYRIA_MAIL_FROM is required with SPYRIA_SMTP_URL.'])
})

test('a sign-in app in the settings takes its client id and secret together', () => {
  const together = 'SPYRIA_SIGN_IN_APP_CLIENT_ID and SPYRIA_SIGN_IN_APP_CLIENT_SECRET are set together or not at all.'
  expect(problemsWith({ SPYRIA_SIGN_IN_APP_CLIENT_ID: 'app', SPYRIA_SIGN_IN_APP_CLIENT_SECRET: 'secret' })).toEqual([])
  expect(problemsWith({ SPYRIA_SIGN_IN_APP_CLIENT_ID: 'app' })).toEqual([together])
  expect(problemsWith({ SPYRIA_SIGN_IN_APP_CLIENT_SECRET: 'secret' })).toEqual([together])
  expect(problemsWith({ SPYRIA_SIGN_IN_APP_CLIENT_ID: 'app', SPYRIA_SIGN_IN_APP_CLIENT_SECRET: '  ' })).toEqual([
    together,
  ])
})

test.each(['SPYRIA_GATEWAY_URL'])('%s is required', (name) => {
  expect(problemsWith({ [name]: '' })).toEqual([`${name} is required.`])
})

test('the gateway admin login is present and not the dev default', () => {
  expect(problemsWith({ SPYRIA_GATEWAY_ADMIN_USER: undefined, SPYRIA_GATEWAY_ADMIN_PASSWORD: undefined })).toEqual([
    'SPYRIA_GATEWAY_ADMIN_USER is required.',
    'SPYRIA_GATEWAY_ADMIN_PASSWORD is required.',
  ])
  expect(
    problemsWith({ SPYRIA_GATEWAY_ADMIN_USER: 'spyria', SPYRIA_GATEWAY_ADMIN_PASSWORD: 'spyria-dev-gateway' }),
  ).toEqual([
    'SPYRIA_GATEWAY_ADMIN_USER must not be a development default.',
    'SPYRIA_GATEWAY_ADMIN_PASSWORD must not be a development default.',
  ])
})

test('every problem is listed at once', () => {
  expect(productionProblemsOf({ SPYRIA_ENV: 'production' })).toHaveLength(9)
})

test('a trusted proxy is unset or cloudflare', () => {
  expect(problemsWith({ SPYRIA_TRUSTED_PROXY: 'cloudflare' })).toEqual([])
  expect(problemsWith({ SPYRIA_TRUSTED_PROXY: 'x-forwarded-for:2' })).toEqual([])
  for (const refused of ['nginx', 'x-forwarded-for:0', 'x-forwarded-for'])
    expect(problemsWith({ SPYRIA_TRUSTED_PROXY: refused })).toEqual([
      'SPYRIA_TRUSTED_PROXY must be unset, cloudflare, or x-forwarded-for:1 to 3.',
    ])
})

test('an install code, when set, is 16 characters of the claim code alphabet', () => {
  expect(problemsWith({ SPYRIA_INSTALL_HOST_TOKEN: 'ABCDEFGHJKMNPQRS' })).toEqual([])
  for (const refused of ['ABC', 'abcdefghjkmnpqrs', 'ABCDEFGHJKMNPQR0'])
    expect(problemsWith({ SPYRIA_INSTALL_HOST_TOKEN: refused })).toEqual([
      'SPYRIA_INSTALL_HOST_TOKEN must be 16 characters from ABCDEFGHJKMNPQRSTUVWXYZ23456789.',
    ])
})
