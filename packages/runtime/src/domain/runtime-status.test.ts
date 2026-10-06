import { expect, test } from 'bun:test'
import type { RuntimeState } from './runtime.ts'
import { runtimeStatusOf } from './runtime.ts'

const statusOf = (state: RuntimeState, hostOnline = true) => runtimeStatusOf({ state, hostOnline })

test('the runtime status follows the runtime state and its host', () => {
  expect(runtimeStatusOf(undefined)).toBe('Not started')
  expect(statusOf('creating')).toBe('Starting…')
  expect(statusOf('starting')).toBe('Starting…')
  expect(statusOf('running')).toBe('Ready')
  expect(statusOf('stopping')).toBe('Sleeping')
  expect(statusOf('stopped')).toBe('Sleeping')
  for (const state of ['failed', 'removing', 'removed'] as const) expect(statusOf(state)).toBe('Could not start')
})

test('a running or sleeping runtime whose host is offline shows Host offline; other states keep their status', () => {
  expect(statusOf('running', false)).toBe('Host offline')
  expect(statusOf('stopped', false)).toBe('Host offline')
  expect(statusOf('starting', false)).toBe('Starting…')
  expect(statusOf('failed', false)).toBe('Could not start')
})
