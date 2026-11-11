import { expect, test } from 'bun:test'
import { isSameSecret } from './same-secret.ts'

const secret = 'AbCdEfGhIjKlMnOp'

test('a secret matches only itself', () => {
  expect(isSameSecret(secret, secret)).toBe(true)
  expect(isSameSecret(secret, 'AbCdEfGhIjKlMnOq')).toBe(false)
  expect(isSameSecret(secret, 'AbCd')).toBe(false)
  expect(isSameSecret(undefined, secret)).toBe(false)
  expect(isSameSecret(secret, undefined)).toBe(false)
  expect(isSameSecret(secret, 42)).toBe(false)
})

test('a value as long as the secret in characters but longer in bytes is refused, not an error', () => {
  expect(isSameSecret(secret, 'ÄbCdEfGhIjKlMnOp')).toBe(false)
})
