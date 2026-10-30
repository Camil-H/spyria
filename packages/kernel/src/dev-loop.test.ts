import { expect, test } from 'bun:test'
import {
  type DevLoopPipeline,
  type DevLoopSettings,
  defaultDevLoopPipeline,
  defaultDevLoopSettings,
  devLoopSettingsFrom,
  isDevLoopSettings,
  pipelineOf,
} from './dev-loop.ts'

const lint = { kind: 'command', name: 'Lint', command: 'bun run lint', timeoutMinutes: 10, fixes: 3 } as const
const appPipeline: DevLoopPipeline = {
  repository: 'acme/app',
  setupCommand: 'bun install',
  steps: [lint, { kind: 'review', fixes: 2 }, { kind: 'pull_request' }, { kind: 'ci', checks: ['ci-ok'], fixes: 1 }],
}
const withPipelines = (...pipelines: DevLoopPipeline[]): DevLoopSettings => ({ ...defaultDevLoopSettings, pipelines })

test('stored settings read back as they are; anything invalid reads as no settings', () => {
  const settings = withPipelines(defaultDevLoopPipeline, appPipeline)
  expect(devLoopSettingsFrom(settings)).toEqual(settings)
  expect(devLoopSettingsFrom(null)).toBeNull()
  expect(devLoopSettingsFrom({ ...settings, timeLimitMinutes: 5 })).toBeNull()
})

test('a repository uses its own pipeline, else the workspace default, else the built-in one', () => {
  const settings = withPipelines({ ...defaultDevLoopPipeline, steps: [lint] }, appPipeline)
  expect(pipelineOf(settings, 'acme/app')).toBe(appPipeline)
  expect(pipelineOf(settings, 'acme/docs').steps).toEqual([lint])
  expect(pipelineOf(withPipelines(appPipeline), 'acme/docs')).toBe(defaultDevLoopPipeline)
  expect(pipelineOf(null, 'acme/app')).toBe(defaultDevLoopPipeline)
})

test.each([
  ['the defaults', defaultDevLoopSettings, true],
  ['a repository pipeline', withPipelines(appPipeline), true],
  ['no fixes, which stops and hands over', withPipelines({ ...appPipeline, steps: [{ ...lint, fixes: 0 }] }), true],
  ['a blank command', withPipelines({ ...appPipeline, steps: [{ ...lint, command: ' ' }] }), false],
  ['a timeout of 0', withPipelines({ ...appPipeline, steps: [{ ...lint, timeoutMinutes: 0 }] }), false],
  ['11 fixes', withPipelines({ ...appPipeline, steps: [{ ...lint, fixes: 11 }] }), false],
  [
    'two reviews',
    withPipelines({
      ...appPipeline,
      steps: [
        { kind: 'review', fixes: 1 },
        { kind: 'review', fixes: 1 },
      ],
    }),
    false,
  ],
  [
    'CI without a pull request',
    withPipelines({ ...appPipeline, steps: [{ kind: 'ci', checks: null, fixes: 1 }] }),
    false,
  ],
  [
    'CI before the pull request',
    withPipelines({ ...appPipeline, steps: [{ kind: 'ci', checks: null, fixes: 1 }, { kind: 'pull_request' }] }),
    false,
  ],
  [
    'a review after the pull request',
    withPipelines({ ...appPipeline, steps: [{ kind: 'pull_request' }, { kind: 'review', fixes: 1 }] }),
    false,
  ],
  ['two commands with one name', withPipelines({ ...appPipeline, steps: [lint, { ...lint, name: 'lint ' }] }), false],
  ['two pipelines for one repository', withPipelines(appPipeline, appPipeline), false],
  ['a cost limit of 0', { ...defaultDevLoopSettings, costLimitMicros: 0 }, false],
  ['no switch', { ...defaultDevLoopSettings, isOn: undefined }, false],
])('%s: valid %p', (_, settings, isValid) => {
  expect(isDevLoopSettings(settings)).toBe(isValid)
})
