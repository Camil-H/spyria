import { expect, test } from 'bun:test'
import { runtimeHostId } from '@spyria/kernel'
import {
  canTransition,
  ensureStepOf,
  idleStepOf,
  installFailureOf,
  installFailureReasonOf,
  isTouchDue,
  placementOf,
  type Runtime,
  type RuntimeState,
  type RuntimeStatus,
  reconciledStateOf,
  removalStepOf,
  runtimeStatusOf,
  transitioned,
} from './runtime.ts'

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
  creating: ['installing', 'running', 'removing', 'failed'],
  starting: ['installing', 'running', 'removing', 'failed'],
  installing: ['running', 'removing', 'failed'],
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
  expect(ensureStepOf(runtime({ state: 'removed' }))).toBe('place')
  expect(ensureStepOf(runtime({ state: 'failed', failure: 'no_host' }))).toBe('place')
  expect(ensureStepOf(runtime({ state: 'failed', failure: 'no_capacity' }))).toBe('place')
  for (const failure of ['create_failed', 'start_failed', 'lost'] as const)
    expect(ensureStepOf(runtime({ state: 'failed', failure }))).toBe('none')
  expect(ensureStepOf(runtime({ state: 'stopped' }))).toBe('start')
  expect(ensureStepOf(runtime({ state: 'running' }))).toBe('touch')
  for (const state of ['creating', 'starting', 'stopping', 'removing'] as const)
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

test.each<[RuntimeState | undefined, boolean, RuntimeStatus]>([
  [undefined, true, 'Not started'],
  ['creating', true, 'Starting…'],
  ['starting', true, 'Starting…'],
  ['running', true, 'Ready'],
  ['stopping', true, 'Sleeping'],
  ['stopped', true, 'Sleeping'],
  ['failed', true, 'Could not start'],
  ['removing', true, 'Could not start'],
  ['removed', true, 'Could not start'],
  ['running', false, 'Host offline'],
  ['stopped', false, 'Host offline'],
  ['starting', false, 'Starting…'],
  ['failed', false, 'Could not start'],
])('a %s runtime with its host online %p reads %s', (state, hostOnline, status) => {
  expect(runtimeStatusOf(state && { state, hostOnline })).toBe(status)
})

test('an installing runtime reads Installing with its harness name, and an install failure keeps npm’s reason', () => {
  expect(runtimeStatusOf({ state: 'installing', hostOnline: true }, 'Claude Code')).toBe('Installing Claude Code…')
  expect(runtimeStatusOf({ state: 'installing', hostOnline: true })).toBe('Starting…')
  const failure = installFailureOf('404 Not Found - GET http://registry/@openai%2fcodex')
  expect(runtimeStatusOf({ state: 'failed', hostOnline: true }, 'Codex')).toBe('Could not start')
  expect(installFailureReasonOf(failure)).toBe('404 Not Found - GET http://registry/@openai%2fcodex')
  expect(installFailureReasonOf('start_failed')).toBeUndefined()
})
