import { expect, test } from 'bun:test'
import { connectionStatusOf } from './personal-connection.ts'

test('the connection status follows the gateway sessions of the member key', () => {
  expect(connectionStatusOf(['active'])).toBe('Connected')
  expect(connectionStatusOf(['needs_reauth'])).toBe('Needs reconnection')
  expect(connectionStatusOf(['needs_reauth', 'active'])).toBe('Connected')
  expect(connectionStatusOf(['orphaned'])).toBeUndefined()
  expect(connectionStatusOf([])).toBeUndefined()
})
