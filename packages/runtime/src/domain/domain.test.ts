import { expect, test } from 'bun:test'
import {
  claimCodeAlphabet,
  claimLifetimeMilliseconds,
  claimRefusal,
  hashSecret,
  isClaimExpired,
  newClaimCode,
  newHostToken,
} from './claim.ts'
import { HostName } from './host-name.ts'
import { capacityOf } from './runtime-host.ts'

const gibibyte = 1024 ** 3
const system = {
  cpus: 8,
  memoryBytes: 8 * gibibyte,
  dockerVersion: '29.0.0',
  rootless: true,
  cgroupDriver: 'systemd',
  limitsEnforced: true,
}

test('a claim code has 8 characters from an alphabet without look-alikes', () => {
  expect(claimCodeAlphabet).not.toMatch(/[01ILO]/)
  expect(claimCodeAlphabet).toHaveLength(31)
  const codes = Array.from({ length: 2000 }, newClaimCode)
  for (const code of codes) expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  expect(new Set(codes).size).toBe(codes.length)
  expect(new Set(codes.join(''))).toEqual(new Set(claimCodeAlphabet))
})

test('a claim code lives 15 minutes', () => {
  const createdAt = Date.parse('2026-10-05T10:00:00Z')
  const expiresAt = createdAt + claimLifetimeMilliseconds
  expect(claimLifetimeMilliseconds).toBe(15 * 60_000)
  expect(isClaimExpired(expiresAt, expiresAt - 1)).toBe(false)
  expect(isClaimExpired(expiresAt, expiresAt)).toBe(true)
})

test('a claim is refused for a removed host first, then a used code, then an expired one', () => {
  const now = Date.parse('2026-10-05T10:00:00Z')
  const fresh = { removedAt: null, claimed: false, claimExpiresAt: now + 1 }
  expect(claimRefusal(fresh, now)).toBeUndefined()
  expect(claimRefusal({ ...fresh, claimExpiresAt: now }, now)?.message).toBe('This code has expired')
  expect(claimRefusal({ ...fresh, claimed: true, claimExpiresAt: now }, now)?.message).toBe(
    'This code was already used',
  )
  expect(claimRefusal({ removedAt: now, claimed: true, claimExpiresAt: now }, now)?.message).toBe(
    'This host was removed',
  )
})

test('a host token carries 256 random bits in base64url', () => {
  const tokens = Array.from({ length: 100 }, newHostToken)
  for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(new Set(tokens).size).toBe(100)
})

test('secrets are stored as their sha256 in hex', async () => {
  expect(await hashSecret('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('the default cap is one runtime per GB after a 2 GB reserve, at least one', () => {
  expect(capacityOf(system).cap).toBe(6)
  expect(capacityOf({ ...system, memoryBytes: 16 * gibibyte }).cap).toBe(14)
  expect(capacityOf({ ...system, memoryBytes: 2.5 * gibibyte }).cap).toBe(1)
  expect(capacityOf({ ...system, memoryBytes: gibibyte }).cap).toBe(1)
  expect(capacityOf(system)).toEqual({ ...system, cap: 6 })
})

test('a host name is trimmed, never blank and at most 60 characters', () => {
  expect<string>(HostName('  Home server ')).toBe('Home server')
  expect(() => HostName('   ')).toThrow('A host name must contain at least one non-blank character')
  expect(HostName('x'.repeat(60))).toHaveLength(60)
  expect(() => HostName('x'.repeat(61))).toThrow('A host name has at most 60 characters')
})
