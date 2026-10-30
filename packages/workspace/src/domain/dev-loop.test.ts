import { expect, test } from 'bun:test'
import { type DevLoopStepConfig, defaultDevLoopPipeline, defaultDevLoopSettings } from '@spyria/kernel'
import { addableKindsOf, withoutPipeline, withoutStep, withPipeline, withStep, withStepMoved } from './dev-loop.ts'

const lint: DevLoopStepConfig = { kind: 'command', name: 'Lint', command: 'bun run lint', timeoutMinutes: 10, fixes: 3 }
const review: DevLoopStepConfig = { kind: 'review', fixes: 2 }
const pullRequest: DevLoopStepConfig = { kind: 'pull_request' }
const ci: DevLoopStepConfig = { kind: 'ci', checks: null, fixes: 2 }
const kindsOf = (steps: readonly DevLoopStepConfig[]) => steps.map(({ kind }) => kind)

test('a new step goes before the pull request, a pull request before CI, and CI last', () => {
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

test('a step moves up or down, never past either end; removing the pull request removes CI with it', () => {
  expect(withStepMoved([lint, review], 1, -1)).toEqual([review, lint])
  expect(withStepMoved([lint, review], 0, -1)).toEqual([lint, review])
  expect(withoutStep([lint, pullRequest, ci], 1)).toEqual([lint])
  expect(withoutStep([lint, pullRequest, ci], 0)).toEqual([pullRequest, ci])
})

test('a pipeline replaces the one of its repository or is added; a repository pipeline can be removed', () => {
  const app = { repository: 'acme/app', setupCommand: null, steps: [lint] }
  const added = withPipeline(defaultDevLoopSettings, app)
  expect(added.pipelines).toEqual([defaultDevLoopPipeline, app])
  expect(withPipeline(added, { ...app, steps: [] }).pipelines).toEqual([defaultDevLoopPipeline, { ...app, steps: [] }])
  expect(withoutPipeline(added, 'acme/app').pipelines).toEqual([defaultDevLoopPipeline])
})
