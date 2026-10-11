import { expect, test } from 'bun:test'
import { runtimeHostId } from '@hq/kernel'
import {
  claimCodeAlphabet,
  claimLifetimeMilliseconds,
  claimRefusal,
  hashSecret,
  isClaimExpired,
  newClaimCode,
  newSecretToken,
} from './claim.ts'
import { hostCommandOf } from './host-command.ts'
import { HostName } from './host-name.ts'
import {
  canTransition,
  ensureStepOf,
  idleStepOf,
  isTouchDue,
  placementOf,
  type Runtime,
  type RuntimeState,
  reconciledStateOf,
  removalStepOf,
  transitioned,
} from './runtime.ts'
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

test('a host token or runtime API key carries 256 random bits in base64url', () => {
  const tokens = Array.from({ length: 100 }, newSecretToken)
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

const minute = 60_000
const now = Date.parse('2026-10-05T10:00:00Z')
const runtime = (fields: Partial<Runtime> = {}) =>
  ({
    workspaceId: 'workspace-acme',
    id: 'runtime-1',
    chatId: 'chat-1',
    hostId: 'host-1',
    state: 'running',
    failure: null,
    image: 'image',
    lastActiveAt: now,
    createdAt: now,
    stateChangedAt: now,
    ...fields,
  }) as Runtime
const allowedTransitions: Record<RuntimeState, RuntimeState[]> = {
  creating: ['running', 'removing', 'failed'],
  starting: ['running', 'removing', 'failed'],
  running: ['stopping', 'stopped', 'removing', 'failed'],
  stopping: ['stopped', 'removing', 'failed'],
  stopped: ['starting', 'running', 'removing', 'failed'],
  removing: ['removed', 'failed'],
  failed: ['removing', 'removed', 'failed'],
  removed: [],
}
const states = Object.keys(allowedTransitions) as RuntimeState[]

test.each(states)('from %s, only the lifecycle transitions are allowed', (from) => {
  for (const to of states) {
    const isAllowed = allowedTransitions[from].includes(to)
    expect(canTransition(from, to)).toBe(isAllowed)
    if (isAllowed) expect(transitioned(runtime({ state: from }), to, now + 1)).toMatchObject({ state: to })
    else expect(() => transitioned(runtime({ state: from }), to, now)).toThrow(`from ${from} to ${to}`)
  }
})

test('a transition stamps its time and sets or clears the failure', () => {
  const failed = transitioned(runtime({ state: 'creating' }), 'failed', now + 5, 'create_failed')
  expect(failed).toMatchObject({ state: 'failed', failure: 'create_failed', stateChangedAt: now + 5 })
  expect(transitioned(failed, 'removing', now + 6)).toMatchObject({ failure: null, stateChangedAt: now + 6 })
})

test('ensuring a runtime places a missing one or a retryable failure, starts a stopped one, touches a running one', () => {
  expect(ensureStepOf(undefined)).toBe('place')
  expect(ensureStepOf(runtime({ state: 'failed', failure: 'no_host' }))).toBe('place')
  expect(ensureStepOf(runtime({ state: 'failed', failure: 'no_capacity' }))).toBe('place')
  for (const failure of ['create_failed', 'start_failed', 'lost'] as const)
    expect(ensureStepOf(runtime({ state: 'failed', failure }))).toBe('none')
  expect(ensureStepOf(runtime({ state: 'stopped' }))).toBe('start')
  expect(ensureStepOf(runtime({ state: 'running' }))).toBe('touch')
  for (const state of ['creating', 'starting', 'stopping', 'removing', 'removed'] as const)
    expect(ensureStepOf(runtime({ state }))).toBe('none')
})

test('placement picks the least-loaded online host below its cap', () => {
  const host = (hostId: string, running: number, cap = 6, online = true) => ({
    hostId: runtimeHostId(hostId),
    running,
    cap,
    online,
  })
  expect(placementOf([])).toEqual({ failure: 'no_host' })
  expect(placementOf([host('offline', 0, 6, false)])).toEqual({ failure: 'no_host' })
  expect(placementOf([host('full', 6), host('offline', 0, 6, false)])).toEqual({ failure: 'no_capacity' })
  expect(placementOf([host('busy', 3), host('quiet', 1), host('offline', 0, 6, false)])).toEqual({
    hostId: runtimeHostId('quiet'),
  })
  expect(placementOf([host('small', 1, 2), host('large', 2, 14)])).toEqual({ hostId: runtimeHostId('large') })
  expect(placementOf([host('full', 2, 2), host('last-slot', 13, 14)])).toEqual({ hostId: runtimeHostId('last-slot') })
})

test('a runtime idle for more than an hour stops, a stopped one idle for more than 30 days is removed', () => {
  const idleFor = (state: RuntimeState, milliseconds: number) =>
    idleStepOf(runtime({ state, lastActiveAt: now - milliseconds }), now)
  expect(idleFor('running', 60 * minute)).toBeUndefined()
  expect(idleFor('running', 60 * minute + 1)).toBe('stopping')
  expect(idleFor('stopped', 30 * 24 * 60 * minute)).toBeUndefined()
  expect(idleFor('stopped', 30 * 24 * 60 * minute + 1)).toBe('removing')
  for (const state of ['creating', 'starting', 'stopping', 'removing', 'removed', 'failed'] as const)
    expect(idleFor(state, 365 * 24 * 60 * minute)).toBeUndefined()
})

test('a touch writes at most once a minute, for a running runtime only', () => {
  expect(isTouchDue(runtime({ lastActiveAt: now - minute + 1 }), now)).toBe(false)
  expect(isTouchDue(runtime({ lastActiveAt: now - minute }), now)).toBe(true)
  expect(isTouchDue(runtime({ state: 'stopped', lastActiveAt: now - 10 * minute }), now)).toBe(false)
})

test('removal goes through the host unless the runtime has none or its host is gone', () => {
  expect(removalStepOf(runtime({ state: 'running' }))).toBe('removing')
  expect(removalStepOf(runtime({ state: 'failed', failure: 'create_failed' }))).toBe('removing')
  expect(removalStepOf(runtime({ state: 'failed', failure: 'no_host', hostId: null }))).toBe('removed')
  expect(removalStepOf(runtime({ state: 'failed', failure: 'lost' }))).toBe('removed')
  expect(removalStepOf(runtime({ state: 'removing' }))).toBeUndefined()
  expect(removalStepOf(runtime({ state: 'removed' }))).toBeUndefined()
})

test('reconciliation follows the container for running and stopped rows only', () => {
  expect(reconciledStateOf(runtime({ state: 'running' }), 'missing')).toBe('stopped')
  expect(reconciledStateOf(runtime({ state: 'running' }), 'stopped')).toBe('stopped')
  expect(reconciledStateOf(runtime({ state: 'running' }), 'running')).toBeUndefined()
  expect(reconciledStateOf(runtime({ state: 'stopped' }), 'running')).toBe('running')
  expect(reconciledStateOf(runtime({ state: 'stopped' }), 'missing')).toBeUndefined()
  expect(reconciledStateOf(runtime({ state: 'creating' }), 'running')).toBeUndefined()
})

test('the rooted host command adds the root group on macOS, where stat has no -c, and the socket group elsewhere', () => {
  const rootedCommand = hostCommandOf({ origin: 'https://hq.test', code: 'ABCDEFGH', rootless: false, personal: true })
  expect(rootedCommand).toContain(
    '--group-add $(test "$(uname)" = Darwin && echo 0 || stat -c %g /var/run/docker.sock)',
  )
  expect(rootedCommand).toEndWith(' hq-host --personal https://hq.test/h/ABCDEFGH')
})
