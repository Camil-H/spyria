import { expect, test } from 'bun:test'
import { addRoutableModels, reachableModelsOf } from '@hq/kernel'
import {
  chipLabelOf,
  runsOnFieldsOf,
  runsOnOf,
  sessionChoiceOf,
  sessionStateOf,
  thoughtLevelOf,
} from './session-routing.ts'

addRoutableModels([
  { id: 'fake/fake-large', name: 'Fake large', tier: 'large' },
  { id: 'fake/fake-medium', name: 'Fake medium', tier: 'medium' },
  { id: 'fake/fake-small', name: 'Fake small', tier: 'small' },
  { id: 'fake-small/fake-small', name: 'Fake small', tier: 'small' },
])
const fake = reachableModelsOf(['fake'])
const smallOnly = reachableModelsOf(['fake-small'])
const jev = reachableModelsOf(['typesafe'])

const classified = (tier: 'large' | 'medium' | 'small', confidence = 0.9) => ({
  tier: { value: tier, confidence },
  effort: { value: 'low', confidence },
})

test('only a confident large or small classification moves away from the chat default', () => {
  const route = (answers: ReturnType<typeof classified> | undefined, defaultModel = 'fake/fake-medium') =>
    sessionChoiceOf({ reachable: fake, defaultModel, answers })
  expect(route(classified('large'))).toMatchObject({
    model: { id: 'fake/fake-large' },
    effort: 'low',
    reason: 'classified large',
  })
  expect(route(classified('small'))).toMatchObject({ model: { id: 'fake/fake-small' } })
  expect(route(classified('large', 0.8))).toMatchObject({ model: { id: 'fake/fake-large' } })
  expect(route(classified('large', 0.79))).toMatchObject({ model: { id: 'fake/fake-medium' }, effort: 'low' })
  expect(route(classified('medium'))?.model.id).toBe('fake/fake-medium')
  expect(route(classified('medium'), 'fake/fake-small')).toMatchObject({
    model: { id: 'fake/fake-small' },
    reason: 'default',
  })
  expect(route(undefined)).toMatchObject({ model: { id: 'fake/fake-medium' }, effort: 'medium' })
  expect(route(undefined, 'fake/fake-small')?.model.id).toBe('fake/fake-small')
})

test('an unreachable or missing default falls back to the nearest reachable model of its tier', () => {
  expect(
    sessionChoiceOf({ reachable: fake, defaultModel: 'anthropic/claude-sonnet-5-5', answers: undefined }),
  ).toMatchObject({ model: { id: 'fake/fake-medium' } })
  expect(sessionChoiceOf({ reachable: fake, defaultModel: null, answers: undefined })?.model.id).toBe(
    'fake/fake-medium',
  )
  expect(
    sessionChoiceOf({ reachable: smallOnly, defaultModel: 'fake/fake-medium', answers: classified('large') })?.model.id,
  ).toBe('fake-small/fake-small')
  expect(
    sessionChoiceOf({ reachable: fake, defaultModel: 'anthropic/claude-haiku-5-5', answers: undefined })?.model.id,
  ).toBe('fake/fake-small')
  expect(sessionChoiceOf({ reachable: [], defaultModel: 'fake/fake-medium', answers: undefined })).toBeUndefined()
  expect(
    sessionChoiceOf({ reachable: [...fake, ...smallOnly], defaultModel: 'fake-small/fake-small', answers: undefined })
      ?.model.id,
  ).toBe('fake-small/fake-small')
  expect(
    sessionChoiceOf({ reachable: [...jev, ...fake], defaultModel: 'typesafe/jev-latest', answers: undefined })?.model
      .id,
  ).toBe('fake/fake-medium')
})

test.each([
  [{ localSession: true, harness: null, model: null }, 'Claude Code · subscription'],
  [{ localSession: true, harness: 'codex', model: 'gpt-large' }, 'Codex · Adapter gpt-large'],
  [
    { localSession: false, harness: null, model: 'fake/fake-large', reasoningEffort: 'high' },
    'Named fake/fake-large (high) · same as main',
  ],
  [{ localSession: false, harness: null, model: 'fake/fake-small' }, 'Named fake/fake-small · same as main'],
  [{ localSession: false, harness: 'codex', model: null }, 'Model chosen at first prompt'],
  [
    { localSession: false, harness: null, model: 'fake/fake-medium', subagentPolicy: 'auto' },
    'Named fake/fake-medium · auto',
  ],
] as const)('the session chip reads %o as %s', (fields, label) => {
  expect(
    chipLabelOf(
      { reasoningEffort: null, subagentPolicy: 'same_as_main', ...fields },
      (id) => (id.startsWith('anthropic/') ? 'Anthropic/Opus 5.5' : `Named ${id}`),
      (id) => `Adapter ${id}`,
    ),
  ).toBe(label)
})

test('the classifier reads the chat mode, non-dev by default; Pi gets only its thought levels', () => {
  expect(sessionStateOf('Fix it', null)).toBe('Chat mode: non-dev\nFirst message:\nFix it')
  expect(sessionStateOf('Fix it', 'dev')).toBe('Chat mode: dev\nFirst message:\nFix it')
  expect(thoughtLevelOf('high')).toBe('high')
  expect(thoughtLevelOf('minimal')).toBe('minimal')
  expect(thoughtLevelOf('extreme')).toBeUndefined()
  expect(thoughtLevelOf(null)).toBeUndefined()
})

test.each([
  [{ localSession: null, harness: null }, null],
  [{ localSession: false, harness: null }, 'runtime'],
  [{ localSession: true, harness: null }, 'claude-code'],
  [{ localSession: true, harness: 'codex' }, 'codex'],
] as const)('a chat with %o runs on %s', (chat, runsOn) => {
  expect(runsOnOf(chat)).toBe(runsOn)
})

test('a Runs on choice sets the chat harness and machine flag', () => {
  expect(runsOnFieldsOf('runtime')).toEqual({ harness: null, localSession: false })
  expect(runsOnFieldsOf('codex')).toEqual({ harness: 'codex', localSession: true })
})
