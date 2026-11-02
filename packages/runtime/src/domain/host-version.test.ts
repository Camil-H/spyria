import { expect, test } from 'bun:test'
import { hostUpdateOf, isHostOutOfDate, minimumHostProtocol } from './host-version.ts'

test('a host below the minimum protocol is out of date, one at or above it is not, and no version counts as protocol 0', () => {
  expect(isHostOutOfDate(0)).toBe(true)
  expect(isHostOutOfDate(minimumHostProtocol - 1)).toBe(true)
  expect(isHostOutOfDate(minimumHostProtocol)).toBe(false)
  expect(isHostOutOfDate(minimumHostProtocol + 5)).toBe(false)
})

test('a host that never said hello shows no update; an out-of-date one needs it; an accepted one on another release has one available', () => {
  expect(hostUpdateOf({ hostVersion: null, protocolVersion: 0 }, '1.2.0')).toBeUndefined()
  expect(hostUpdateOf({ hostVersion: '1.0.0', protocolVersion: 0 }, '1.2.0')).toBe('needed')
  expect(hostUpdateOf({ hostVersion: '1.1.0', protocolVersion: minimumHostProtocol }, '1.2.0')).toBe('available')
  expect(hostUpdateOf({ hostVersion: '1.2.0', protocolVersion: minimumHostProtocol }, '1.2.0')).toBeUndefined()
})
