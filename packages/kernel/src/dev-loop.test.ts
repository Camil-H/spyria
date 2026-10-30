import { expect, test } from 'bun:test'
import {
  type DevLoopRules,
  type DevLoopSettings,
  defaultDevLoopRules,
  defaultDevLoopSettings,
  devLoopSettingsFrom,
  isAnyRuleOn,
  isDevLoopSettings,
  isSetupCommands,
  rulesOf,
  setupCommandOf,
  setupCommandsFrom,
} from './dev-loop.ts'

const lint = { kind: 'command', name: 'Lint', command: 'bun run lint', timeoutMinutes: 10, fixes: 3 } as const
const appRules: DevLoopRules = {
  repository: 'acme/app',
  isOn: true,
  timeLimitMinutes: 60,
  costLimitMicros: 5_000_000,
  steps: [lint, { kind: 'review', fixes: 2 }, { kind: 'pull_request' }, { kind: 'ci', fixes: 1 }],
}
const withRules = (...rules: DevLoopRules[]): DevLoopSettings => ({ rules })
const withAppSteps = (steps: DevLoopRules['steps']) => withRules({ ...appRules, steps })

test('stored settings read back as they are; anything invalid reads as no settings', () => {
  const settings = withRules(defaultDevLoopRules, appRules)
  expect(devLoopSettingsFrom(settings)).toEqual(settings)
  expect(devLoopSettingsFrom(null)).toBeNull()
  expect(devLoopSettingsFrom(withRules({ ...appRules, timeLimitMinutes: 5 }))).toBeNull()
})

test('a repository follows its own rules, else the default rules, else the built-in ones, which are off', () => {
  const settings = withRules({ ...defaultDevLoopRules, steps: [lint] }, appRules)
  expect(rulesOf(settings, 'acme/app')).toBe(appRules)
  expect(rulesOf(settings, 'acme/docs').steps).toEqual([lint])
  expect(rulesOf(withRules(appRules), 'acme/docs')).toBe(defaultDevLoopRules)
  expect(rulesOf(null, 'acme/app').isOn).toBe(false)
  expect(isAnyRuleOn(withRules(defaultDevLoopRules, appRules))).toBe(true)
  expect(isAnyRuleOn(defaultDevLoopSettings)).toBe(false)
})

test.each([
  ['the defaults', defaultDevLoopSettings, true],
  ['rules for a repository', withRules(appRules), true],
  ['no fixes, which stops and hands over', withAppSteps([{ ...lint, fixes: 0 }]), true],
  ['a blank command', withAppSteps([{ ...lint, command: ' ' }]), false],
  ['a timeout of 0', withAppSteps([{ ...lint, timeoutMinutes: 0 }]), false],
  ['11 fixes', withAppSteps([{ ...lint, fixes: 11 }]), false],
  [
    'two reviews',
    withAppSteps([
      { kind: 'review', fixes: 1 },
      { kind: 'review', fixes: 1 },
    ]),
    false,
  ],
  ['CI without a pull request', withAppSteps([{ kind: 'ci', fixes: 1 }]), false],
  ['CI before the pull request', withAppSteps([{ kind: 'ci', fixes: 1 }, { kind: 'pull_request' }]), false],
  ['a review after the pull request', withAppSteps([{ kind: 'pull_request' }, { kind: 'review', fixes: 1 }]), false],
  ['two commands with one name', withAppSteps([lint, { ...lint, name: 'lint ' }]), false],
  ['two rules for one repository', withRules(appRules, appRules), false],
  ['a cost limit of 0', withRules({ ...appRules, costLimitMicros: 0 }), false],
  ['a time limit of 5 minutes', withRules({ ...appRules, timeLimitMinutes: 5 }), false],
  ['no switch', withRules({ ...appRules, isOn: undefined as unknown as boolean }), false],
])('%s: valid %p', (_, settings, isValid) => {
  expect(isDevLoopSettings(settings)).toBe(isValid)
})

test('a repository runs its own setup command, else the default one, else none; setup commands need a command and one per repository', () => {
  const commands = [
    { repository: null, command: 'bun install' },
    { repository: 'acme/app', command: 'bun install && bun run db:migrate' },
  ]
  expect(setupCommandOf(commands, 'acme/app')).toBe('bun install && bun run db:migrate')
  expect(setupCommandOf(commands, 'acme/docs')).toBe('bun install')
  expect(setupCommandOf([], 'acme/docs')).toBeNull()
  expect(isSetupCommands(commands)).toBe(true)
  expect(isSetupCommands([{ repository: 'acme/app', command: ' ' }])).toBe(false)
  expect(isSetupCommands([...commands, { repository: null, command: 'make' }])).toBe(false)
  expect(setupCommandsFrom('bun install')).toEqual([])
})
