import { expect, test } from 'bun:test'
import { hostUpdateOf, isHostOutOfDate, minimumHostProtocol } from './host-version.ts'

test('a host below the minimum protocol is out of date, one at or above it is not, and no version counts as protocol 0', () => {
  expect(isHostOutOfDate(0)).toBe(true)
  expect(isHostOutOfDate(minimumHostProtocol - 1)).toBe(true)
  expect(isHostOutOfDate(minimumHostProtocol)).toBe(false)
  expect(isHostOutOfDate(minimumHostProtocol + 5)).toBe(false)
})

test('a host that never paired shows no update; a paired one below the minimum needs it, with or without a version; an accepted one on another release has one available', () => {
  expect(hostUpdateOf({ status: 'waiting', hostVersion: null, protocolVersion: 0 }, '1.2.0')).toBeUndefined()
  expect(hostUpdateOf({ status: 'expired', hostVersion: null, protocolVersion: 0 }, '1.2.0')).toBeUndefined()
  expect(hostUpdateOf({ status: 'offline', hostVersion: null, protocolVersion: 0 }, '1.2.0')).toBe('needed')
  expect(hostUpdateOf({ status: 'offline', hostVersion: '1.0.0', protocolVersion: 0 }, '1.2.0')).toBe('needed')
  expect(hostUpdateOf({ status: 'online', hostVersion: '1.1.0', protocolVersion: minimumHostProtocol }, '1.2.0')).toBe(
    'available',
  )
  expect(
    hostUpdateOf({ status: 'online', hostVersion: '1.2.0', protocolVersion: minimumHostProtocol }, '1.2.0'),
  ).toBeUndefined()
})
