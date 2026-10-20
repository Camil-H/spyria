import { expect, test } from 'bun:test'
import { productionProblemsOf } from './production.ts'

const production = {
  SPYRIA_ENV: 'production',
  SPYRIA_AUTH_MODE: 'sso',
  SPYRIA_TOKEN_SECRET: 'a'.repeat(64),
  SPYRIA_SECRETS_KEY: 'b'.repeat(64),
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

test.each(['SPYRIA_TOKEN_SECRET', 'SPYRIA_SECRETS_KEY'])('%s is present, long enough and not a dev default', (name) => {
  expect(problemsWith({ [name]: undefined })).toEqual([`${name} is required.`])
  expect(problemsWith({ [name]: 'x'.repeat(31) })).toEqual([`${name} must be at least 32 characters.`])
  expect(problemsWith({ [name]: 'spyria-dev-gateway-encryption-key' })).toEqual([
    `${name} must not be a development default.`,
  ])
})

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

test.each(['SPYRIA_SMTP_URL', 'SPYRIA_MAIL_FROM', 'SPYRIA_GATEWAY_URL'])('%s is required', (name) => {
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
  expect(productionProblemsOf({ SPYRIA_ENV: 'production' })).toHaveLength(10)
})
