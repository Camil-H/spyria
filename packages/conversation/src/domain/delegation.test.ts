import { expect, test } from 'bun:test'
import { reachableModelsOf } from '@spyria/kernel'
import type { AgentStep } from './agent-steps.ts'
import {
  askedChoiceOf,
  cancelledTaskOf,
  delegationChoiceOf,
  routerTools,
  stillRunningOf,
  taskProgressOf,
  taskReportOf,
} from './delegation.ts'

const anthropicModels = reachableModelsOf(['anthropic'])
const smallOnly = anthropicModels.filter((model) => model.tier === 'small')

test('an asked model the keys reach is used as asked', () => {
  expect(askedChoiceOf(anthropicModels, 'Opus 5.5', 'Bob')).toEqual({
    model: 'anthropic/claude-opus-5-5',
    reason: 'asked',
  })
  expect(askedChoiceOf(anthropicModels, 'claude-haiku-5-5', 'Bob')).toEqual({
    model: 'anthropic/claude-haiku-5-5',
    reason: 'asked',
  })
  expect(askedChoiceOf(anthropicModels, 'medium', 'Bob')).toEqual({
    model: 'anthropic/claude-sonnet-5-5',
    reason: 'asked',
  })
})

test('an unreachable asked model or tier falls back to the nearest reachable one and says so', () => {
  const fallback = "Opus 5.5 isn't reachable with Bob's keys; used Haiku 5.5"
  expect(askedChoiceOf(smallOnly, 'Opus 5.5', 'Bob')).toEqual({
    model: 'anthropic/claude-haiku-5-5',
    reason: fallback,
    fallback,
  })
  expect(askedChoiceOf(smallOnly, 'large', 'Bob')?.fallback).toBe(
    "large isn't reachable with Bob's keys; used Haiku 5.5",
  )
  expect(askedChoiceOf(reachableModelsOf(['openai']), 'Sonnet 5.5', 'Bob')?.model).toBe('openai/gpt-5-mini')
})

test('no asked model, or an unknown one, leaves the choice to the policy and the classifier', () => {
  expect(askedChoiceOf(anthropicModels, undefined, 'Bob')).toBeUndefined()
  expect(askedChoiceOf(anthropicModels, 'a model nobody lists', 'Bob')).toBeUndefined()
})

test('only a confident classification picks the subagent model; a low-confidence or failed one picks none', () => {
  const small = { tier: { value: 'small', confidence: 1 }, effort: { value: 'low', confidence: 1 } }
  expect(delegationChoiceOf(anthropicModels, small)).toEqual({
    model: 'anthropic/claude-haiku-5-5',
    effort: 'low',
    reason: 'classified small',
  })
  expect(delegationChoiceOf(anthropicModels, { ...small, tier: { value: 'small', confidence: 0 } })).toBeUndefined()
  expect(delegationChoiceOf(anthropicModels, undefined)).toBeUndefined()
})

test('the router offers delegate({ task, effort }), await_task({ taskId }) and check_task({ taskId, cancel }), and a still-running answer names await_task', () => {
  expect(
    routerTools.map(({ name, inputSchema }) => [name, inputSchema.required, Object.keys(inputSchema.properties)]),
  ).toEqual([
    ['delegate', ['task', 'effort'], ['task', 'effort', 'model']],
    ['await_task', ['taskId'], ['taskId']],
    ['check_task', ['taskId'], ['taskId', 'cancel']],
  ])
  expect(stillRunningOf('t-1')).toBe('Task t-1 is still running; call await_task with taskId="t-1"')
})

test('check_task reports the last steps of a running task in a line each, and its reports read apart from an answer', () => {
  const steps: AgentStep[] = [
    { type: 'command', command: 'ls', exitCode: 0, durationMilliseconds: 5, output: '', truncatedLines: 0 },
    { type: 'file', operation: 'edit', path: 'src/app.ts', added: 1, removed: 0, diff: [] },
    { type: 'tool', name: 'fake_lookup', arguments: '{}', result: null },
    { type: 'tool', name: 'fake_update', arguments: '{}', result: 'denied', isError: true },
    { type: 'thought', text: 'x'.repeat(300), durationMilliseconds: null },
    { type: 'error', message: 'Overloaded' },
  ]
  expect(taskProgressOf('t-1', steps)).toBe(
    [
      'Task t-1 is running; its steps so far:',
      '- ran ls (exit 0)',
      '- edited src/app.ts',
      '- called fake_lookup',
      '- called fake_update (failed)',
      `- thought: ${'x'.repeat(200)}`,
      '- error: Overloaded',
    ].join('\n'),
  )
  const commandOf = (index: number): AgentStep => ({
    type: 'command',
    command: `step ${index}`,
    exitCode: 0,
    durationMilliseconds: 5,
    output: '',
    truncatedLines: 0,
  })
  const many = Array.from({ length: 23 }, (_, index) => commandOf(index))
  const report = taskProgressOf('t-1', many).split('\n')
  expect(report.slice(1, 3)).toEqual(['(3 earlier steps not shown)', '- ran step 3 (exit 0)'])
  expect(report).toHaveLength(22)
  expect(taskProgressOf('t-1', [])).toBe('Task t-1 is running and has taken no step yet')
  expect(cancelledTaskOf('t-1', steps.slice(0, 1))).toBe('Task t-1 was cancelled; its steps:\n- ran ls (exit 0)')
  expect(cancelledTaskOf('t-1', [])).toBe('Task t-1 was cancelled before taking any step')
  expect(
    [taskProgressOf('t-1', []), cancelledTaskOf('t-1', []), 'Task t-1 is done', null].map((text) =>
      taskReportOf('t-1', text),
    ),
  ).toEqual(['running', 'cancelled', undefined, undefined])
})
