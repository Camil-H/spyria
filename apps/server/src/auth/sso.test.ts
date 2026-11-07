import { expect, test } from 'bun:test'
import { isInstallHostToken } from './sso.ts'

const installHostToken = 'AbCdEfGhIjKlMnOp'

test('the install host token matches only itself', () => {
  expect(isInstallHostToken(installHostToken, installHostToken)).toBe(true)
  expect(isInstallHostToken(installHostToken, 'AbCdEfGhIjKlMnOq')).toBe(false)
  expect(isInstallHostToken(installHostToken, 'AbCd')).toBe(false)
  expect(isInstallHostToken(undefined, installHostToken)).toBe(false)
})

test('a code as long as the token in characters but longer in bytes is refused, not an error', () => {
  expect(isInstallHostToken(installHostToken, 'ÄbCdEfGhIjKlMnOp')).toBe(false)
})
