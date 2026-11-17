import { expect, test } from 'bun:test'
import { DomainError } from '@spyria/kernel'
import { HostNotConnected } from './errors.ts'

test('a host that is not connected yet is no refusal shown to a member, so the jobs that meet it retry', () => {
  const error = new HostNotConnected('host-1')
  expect(error).not.toBeInstanceOf(DomainError)
  expect(error.hostId).toBe('host-1')
})
