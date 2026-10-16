import { expect, test } from 'bun:test'
import type { RuntimeState, RuntimeStatus } from './runtime.ts'
import { runtimeStatusOf } from './runtime.ts'

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
