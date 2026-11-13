import { expect, test } from 'bun:test'
import { capacityOf, isHostStale, signInsOf, withExpiredSignIn } from './runtime-host.ts'

const gibibyte = 1024 ** 3
const system = {
  cpus: 8,
  memoryBytes: 8 * gibibyte,
  dockerVersion: '29.0.0',
  rootless: true,
  cgroupDriver: 'systemd',
  limitsEnforced: true,
}

test('the default cap is one runtime per GB after a 2 GB reserve, at least one', () => {
  expect(capacityOf(system).cap).toBe(6)
  expect(capacityOf({ ...system, memoryBytes: 16 * gibibyte }).cap).toBe(14)
  expect(capacityOf({ ...system, memoryBytes: 2.5 * gibibyte }).cap).toBe(1)
  expect(capacityOf({ ...system, memoryBytes: gibibyte }).cap).toBe(1)
  expect(capacityOf(system)).toEqual({ ...system, cap: 6 })
})

test('an expired sign-in drops the tool until its credentials file changes or goes', () => {
  const declared = { signedIn: ['claude-code', 'codex'], credentialsChangedAt: { 'claude-code': 100, codex: 200 } }
  const expired = withExpiredSignIn({ ...capacityOf(system), ...declared }, 'claude-code')
  expect(expired).toMatchObject({ signedIn: ['codex'], expiredSignIns: { 'claude-code': 100 } })
  expect(signInsOf(declared, expired.expiredSignIns)).toEqual({
    ...declared,
    signedIn: ['codex'],
    expiredSignIns: { 'claude-code': 100 },
  })
  expect(
    signInsOf({ ...declared, credentialsChangedAt: { 'claude-code': 101, codex: 200 } }, expired.expiredSignIns),
  ).toEqual({
    signedIn: ['claude-code', 'codex'],
    credentialsChangedAt: { 'claude-code': 101, codex: 200 },
    expiredSignIns: {},
  })
  expect(
    signInsOf({ signedIn: ['codex'], credentialsChangedAt: { codex: 200 } }, expired.expiredSignIns),
  ).toMatchObject({
    expiredSignIns: {},
  })
})

test('an online host is stale once unseen for three of its declared heartbeats, thirty seconds each by default', () => {
  const minute = 60_000
  const now = 100 * minute
  const host = (
    lastSeenAt: number | null,
    heartbeatMilliseconds?: number,
    status: 'online' | 'offline' = 'online',
  ) => ({
    status,
    lastSeenAt,
    capacity: { ...capacityOf(system), ...(heartbeatMilliseconds !== undefined && { heartbeatMilliseconds }) },
  })
  expect(isHostStale(host(now - 89_000), now)).toBe(false)
  expect(isHostStale(host(now - 91_000), now)).toBe(true)
  expect(isHostStale({ ...host(now - 91_000), capacity: null }, now)).toBe(true)
  expect(isHostStale(host(now - 10 * minute, 5 * minute), now)).toBe(false)
  expect(isHostStale(host(now - 16 * minute, 5 * minute), now)).toBe(true)
  expect(isHostStale(host(now - 2 * minute, 1000), now)).toBe(true)
  expect(isHostStale(host(now - 10 * minute, undefined, 'offline'), now)).toBe(false)
  expect(isHostStale(host(null), now)).toBe(true)
})
