import { expect, test } from 'bun:test'
import { agentNotices, stoppedByNoticeOf } from './agent-events.ts'
import { agentStatusOf } from './agent-status.ts'

const answer = { kind: 'agent', body: 'Done, the tests pass.', step: null } as const
const question = (fields: Record<string, unknown> = {}) =>
  ({ kind: 'step', body: 'question', step: { type: 'question', questionId: 'question-1', ...fields } }) as const
const notice = (body: string) => ({ kind: 'notice', body, step: null }) as const

test.each([
  ['a chat the agent never answered has no status', false, undefined, null],
  ['a running turn is working', true, answer, 'working'],
  ['a running turn before any activity is working', true, undefined, 'working'],
  ['an open question waits for an answer, even while the turn runs', true, question(), 'waiting'],
  ['an open approval waits for an answer', true, question({ kind: 'approval' }), 'waiting'],
  ['an answered question no longer waits', true, question({ answers: {} }), 'working'],
  ['a decided approval no longer waits', true, question({ approved: false }), 'working'],
  ['a question closed at turn end is done', false, question({ closed: 'turn_end' }), 'done'],
  ['a finished turn with an answer is done', false, answer, 'done'],
  [
    'an error step is an error',
    false,
    { kind: 'step', body: 'error', step: { type: 'error', message: 'Boom' } },
    'error',
  ],
  ['a failure notice is an error', false, notice(agentNotices.stoppedWithError), 'error'],
  ['a model call failure notice is an error', false, notice('The model call failed (error 500)'), 'error'],
  ['a member stopping the agent is done', false, notice(stoppedByNoticeOf('Alice')), 'done'],
  ['a new session notice is done', false, notice(agentNotices.newSession), 'done'],
] as const)('%s', (_, isTurnActive, latestActivity, status) => {
  expect(agentStatusOf({ isTurnActive, isRuntimeAsleep: false, latestActivity })).toBe(status)
})

test.each([
  ['a finished turn on a runtime asleep is sleeping', false, answer, 'sleeping'],
  [
    'a member stopping the agent before its runtime fell asleep is sleeping',
    false,
    notice(stoppedByNoticeOf('Alice')),
    'sleeping',
  ],
  ['an error stays an error once the runtime is asleep', false, notice(agentNotices.stoppedWithError), 'error'],
  ['an open question still waits once the runtime is asleep', false, question(), 'waiting'],
  ['a turn waking the runtime is working', true, answer, 'working'],
  ['a runtime asleep before the agent ever answered has no status', false, undefined, null],
] as const)('%s', (_, isTurnActive, latestActivity, status) => {
  expect(agentStatusOf({ isTurnActive, isRuntimeAsleep: true, latestActivity })).toBe(status)
})
