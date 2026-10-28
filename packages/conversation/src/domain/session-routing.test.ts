import { expect, test } from 'bun:test'
import { reachableModelsOf } from '@spyria/kernel'
import {
  chipLabelOf,
  runsOnFieldsOf,
  runsOnOf,
  sessionChoiceOf,
  sessionStateOf,
  thoughtLevelOf,
} from './session-routing.ts'

const mistral = reachableModelsOf(['mistral'])
const smallOnly = reachableModelsOf(['xai']).filter((model) => model.tier === 'small')
const jev = reachableModelsOf(['typesafe'])

const classified = (tier: 'large' | 'medium' | 'small', confidence = 0.9) => ({
  tier: { value: tier, confidence },
  effort: { value: 'low', confidence },
})

test('only a confident large or small classification moves away from the medium tier', () => {
  const route = (answers: ReturnType<typeof classified> | undefined) => sessionChoiceOf({ reachable: mistral, answers })
  expect(route(classified('large'))).toMatchObject({
    model: { id: 'mistral/mistral-large-latest' },
    effort: 'low',
    reason: 'classified large',
  })
  expect(route(classified('small'))).toMatchObject({ model: { id: 'mistral/mistral-small-latest' } })
  expect(route(classified('large', 0.8))).toMatchObject({ model: { id: 'mistral/mistral-large-latest' } })
  expect(route(classified('large', 0.79))).toMatchObject({
    model: { id: 'mistral/mistral-medium-latest' },
    effort: 'low',
  })
  expect(route(classified('medium'))).toMatchObject({
    model: { id: 'mistral/mistral-medium-latest' },
    reason: 'default',
  })
  expect(route(undefined)).toMatchObject({ model: { id: 'mistral/mistral-medium-latest' }, effort: 'medium' })
})

test('the fallback is the best reachable model of the prompter: medium tier first, ties in catalog order', () => {
  const openAiOnly = reachableModelsOf(['openai'])
  expect(sessionChoiceOf({ reachable: openAiOnly, answers: undefined })?.model.id).toBe('openai/gpt-5-mini')
  expect(sessionChoiceOf({ reachable: openAiOnly, answers: classified('large') })?.model.id).toBe('openai/gpt-5')
  expect(sessionChoiceOf({ reachable: openAiOnly, answers: classified('small') })?.model.id).toBe('openai/gpt-5-nano')
  expect(sessionChoiceOf({ reachable: reachableModelsOf(['mistral', 'openai']), answers: undefined })?.model.id).toBe(
    'openai/gpt-5-mini',
  )
  expect(sessionChoiceOf({ reachable: smallOnly, answers: classified('large') })?.model.id).toBe('xai/grok-code-fast-1')
  expect(sessionChoiceOf({ reachable: smallOnly, answers: undefined })?.model.id).toBe('xai/grok-code-fast-1')
  expect(sessionChoiceOf({ reachable: [], answers: undefined })).toBeUndefined()
  expect(sessionChoiceOf({ reachable: jev, answers: undefined })).toBeUndefined()
  expect(sessionChoiceOf({ reachable: [...jev, ...mistral], answers: undefined })?.model.id).toBe(
    'mistral/mistral-medium-latest',
  )
})

test.each([
  [{ localSession: true, harness: null, model: null }, 'Claude Code · subscription'],
  [{ localSession: true, harness: 'codex', model: 'gpt-large' }, 'Codex · Adapter gpt-large'],
  [{ localSession: true, harness: null, model: null, reasoningEffort: 'max' }, 'Claude Code · subscription (max)'],
  [
    { localSession: true, harness: 'codex', model: 'gpt-large', reasoningEffort: 'high' },
    'Codex · Adapter gpt-large (high)',
  ],
  [
    { localSession: false, harness: null, model: 'mistral/mistral-large-latest', reasoningEffort: 'high' },
    'Named mistral/mistral-large-latest (high)',
  ],
  [{ localSession: false, harness: null, model: 'mistral/mistral-small-latest' }, 'Named mistral/mistral-small-latest'],
  [{ localSession: false, harness: 'codex', model: null }, 'Model chosen at first prompt'],
  [{ localSession: false, harness: null, model: null, isAgentWorking: true }, 'Choosing model…'],
  [{ localSession: true, harness: null, model: null, isAgentWorking: true }, 'Claude Code · subscription'],
  [
    { localSession: false, harness: null, model: 'mistral/mistral-small-latest', isAgentWorking: true },
    'Named mistral/mistral-small-latest',
  ],
] as const)(
  'the session chip reads %o as %s: model and effort only, the subagent policy stays in the dialog',
  (fields, label) => {
    expect(
      chipLabelOf(
        { reasoningEffort: null, ...fields },
        (id) => (id.startsWith('anthropic/') ? 'Anthropic/Opus 5.5' : `Named ${id}`),
        (id) => `Adapter ${id}`,
      ),
    ).toBe(label)
  },
)

test('the classifier reads the chat mode, non-dev by default; Pi gets only its thought levels', () => {
  expect(sessionStateOf('Fix it', null)).toBe('Chat mode: non-dev\nFirst message:\nFix it')
  expect(sessionStateOf('Fix it', 'dev')).toBe('Chat mode: dev\nFirst message:\nFix it')
  expect(thoughtLevelOf('high')).toBe('high')
  expect(thoughtLevelOf('minimal')).toBe('minimal')
  expect(thoughtLevelOf('xhigh')).toBe('xhigh')
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
