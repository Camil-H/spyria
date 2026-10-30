import { expect, test } from 'bun:test'
import { type DevLoopStepConfig, defaultDevLoopRules, defaultDevLoopSettings } from '@spyria/kernel'
import {
  addableKindsOf,
  invalidRulesOf,
  withNewRules,
  withoutRules,
  withoutStep,
  withRules,
  withStep,
  withStepMoved,
} from './dev-loop.ts'

const lint: DevLoopStepConfig = { kind: 'command', name: 'Lint', command: 'bun run lint', timeoutMinutes: 10, fixes: 3 }
const review: DevLoopStepConfig = { kind: 'review', fixes: 2 }
const pullRequest: DevLoopStepConfig = { kind: 'pull_request' }
const ci: DevLoopStepConfig = { kind: 'ci', fixes: 2 }
const kindsOf = (steps: readonly DevLoopStepConfig[]) => steps.map(({ kind }) => kind)

test('a new gate goes before the pull request, a pull request before CI, and CI last', () => {
  expect(kindsOf(withStep([review, pullRequest, ci], 'command'))).toEqual(['review', 'command', 'pull_request', 'ci'])
  expect(kindsOf(withStep([lint, ci], 'pull_request'))).toEqual(['command', 'pull_request', 'ci'])
  expect(kindsOf(withStep([lint, pullRequest], 'ci'))).toEqual(['command', 'pull_request', 'ci'])
  expect(kindsOf(withStep([lint], 'review'))).toEqual(['command', 'review'])
})

test('commands can always be added; review, pull request and CI once each, and CI only after a pull request', () => {
  expect(addableKindsOf([])).toEqual(['command', 'review', 'pull_request'])
  expect(addableKindsOf([lint, review, pullRequest])).toEqual(['command', 'ci'])
  expect(addableKindsOf([review, pullRequest, ci])).toEqual(['command'])
})

test('a gate moves up or down, never past either end nor out of publishing order; removing the pull request removes CI', () => {
  expect(withStepMoved([lint, review], 1, -1)).toEqual([review, lint])
  expect(withStepMoved([lint, review], 0, -1)).toEqual([lint, review])
  expect(withStepMoved([lint, pullRequest, ci], 2, -1)).toEqual([lint, pullRequest, ci])
  expect(withStepMoved([lint, pullRequest], 0, 1)).toEqual([lint, pullRequest])
  expect(withoutStep([lint, pullRequest, ci], 1)).toEqual([lint])
  expect(withoutStep([lint, pullRequest, ci], 0)).toEqual([pullRequest, ci])
})

test('new repository rules start as a copy of the default rules; rules replace those of their repository and can be removed', () => {
  const custom = withRules(defaultDevLoopSettings, { ...defaultDevLoopRules, isOn: true, steps: [lint] })
  const added = withNewRules(custom, 'acme/app')
  expect(added.rules.at(-1)).toEqual({ ...defaultDevLoopRules, isOn: true, steps: [lint], repository: 'acme/app' })
  expect(withRules(added, { ...defaultDevLoopRules, repository: 'acme/app' }).rules).toHaveLength(2)
  expect(withoutRules(added, 'acme/app')).toEqual(custom)
})

test('the first rules that cannot be saved are found, so their tab can be shown', () => {
  const broken = { ...defaultDevLoopRules, repository: 'acme/app', steps: [{ ...lint, command: '' }] }
  expect(invalidRulesOf(withRules(defaultDevLoopSettings, broken))?.repository).toBe('acme/app')
  expect(invalidRulesOf(defaultDevLoopSettings)).toBeUndefined()
})
