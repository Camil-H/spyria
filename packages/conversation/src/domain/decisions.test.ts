import { expect, test } from 'bun:test'
import { answersOf, decisionRequestOf } from './decisions.ts'
import { sessionQuestions } from './session-routing.ts'

const jev = { id: 'typesafe/jev-latest', name: 'Jev' }
const fakeSmall = { id: 'fake/fake-small', name: 'Fake small', tier: 'small' as const }
const chatReply = (content: string) => ({ choices: [{ message: { content } }] })

test('a decision model gets choice questions, a chat model the json_schema request', () => {
  expect(decisionRequestOf(jev, 'Chat mode: dev', sessionQuestions)).toEqual({
    model: 'typesafe/jev-latest',
    state: 'Chat mode: dev',
    questions: {
      tier: { kind: 'choice', ...sessionQuestions.tier },
      effort: { kind: 'choice', ...sessionQuestions.effort },
    },
  })
  const chatRequest = decisionRequestOf(fakeSmall, 'Refactor the billing module', sessionQuestions)
  expect(chatRequest).toMatchObject({
    model: 'fake/fake-small',
    response_format: { type: 'json_schema', json_schema: { schema: { required: ['tier', 'effort', 'confidence'] } } },
  })
  expect(JSON.stringify(chatRequest)).toContain('Refactor the billing module')
})

test('decision answers keep their confidence and need a valid choice for every question', () => {
  const answers = { tier: { kind: 'choice', value: 'large', confidence: 0.9 }, effort: { value: 'low' } }
  expect(answersOf(jev, sessionQuestions, { answers })).toEqual({
    tier: { value: 'large', confidence: 0.9 },
    effort: { value: 'low', confidence: 0 },
  })
  expect(answersOf(jev, sessionQuestions, { answers: { ...answers, tier: { value: 'huge' } } })).toBeUndefined()
  expect(answersOf(jev, sessionQuestions, {})).toBeUndefined()
})

test('a chat answer is the first JSON object in the text, its self-rated confidence mapped to 1 or 0', () => {
  const json = '{"tier":"small","effort":"low","confidence":"high","reason":"a {brace}"}'
  expect(answersOf(fakeSmall, sessionQuestions, chatReply(`Sure! ${json} Anything else? {"tier":"large"}`))).toEqual({
    tier: { value: 'small', confidence: 1 },
    effort: { value: 'low', confidence: 1 },
  })
  expect(
    answersOf(fakeSmall, sessionQuestions, chatReply('{"tier":"large","effort":"high","confidence":"low"}')),
  ).toMatchObject({ tier: { value: 'large', confidence: 0 } })
  expect(answersOf(fakeSmall, sessionQuestions, chatReply('{"tier":"large","effort":"high"}'))).toBeUndefined()
  expect(answersOf(fakeSmall, sessionQuestions, chatReply('no json here'))).toBeUndefined()
  expect(answersOf(fakeSmall, sessionQuestions, undefined)).toBeUndefined()
})
