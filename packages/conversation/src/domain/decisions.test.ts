import { expect, test } from 'bun:test'
import { answersOf, decisionRequestOf } from './decisions.ts'
import { sessionQuestions } from './session-routing.ts'

const jev = { id: 'typesafe/jev-latest', name: 'Jev' }
const fakeSmall = { id: 'mistral/mistral-small-latest', name: 'Mistral Small', tier: 'small' as const }
const chatReply = (content: string) => ({ choices: [{ message: { content } }] })

const choicesOf = (criteria: Record<string, string>) =>
  Object.entries(criteria).map(([value, description]) => ({ value, description }))

test('a decision model gets a list of named choice questions, a chat model the json_schema request', () => {
  expect(decisionRequestOf(jev, 'Chat mode: dev', sessionQuestions)).toEqual({
    model: 'typesafe/jev-latest',
    input: 'Chat mode: dev',
    questions: [
      {
        type: 'choice',
        name: 'tier',
        instructions: sessionQuestions.tier.instructions,
        choices: choicesOf(sessionQuestions.tier.criteria),
      },
      {
        type: 'choice',
        name: 'effort',
        instructions: sessionQuestions.effort.instructions,
        choices: choicesOf(sessionQuestions.effort.criteria),
      },
    ],
  })
  const chatRequest = decisionRequestOf(fakeSmall, 'Refactor the billing module', sessionQuestions)
  expect(chatRequest).toMatchObject({
    model: 'mistral/mistral-small-latest',
    response_format: { type: 'json_schema', json_schema: { schema: { required: ['tier', 'effort', 'confidence'] } } },
  })
  expect(JSON.stringify(chatRequest)).toContain('Refactor the billing module')
})

test('decision answers are matched by name, keep their confidence and need a valid choice for every question', () => {
  const effort = { type: 'choice', name: 'effort', choice: 'low' }
  const tier = { type: 'choice', name: 'tier', choice: 'large', confidence: 0.9 }
  expect(answersOf(jev, sessionQuestions, { answers: [effort, tier] })).toEqual({
    tier: { value: 'large', confidence: 0.9 },
    effort: { value: 'low', confidence: 0 },
  })
  expect(answersOf(jev, sessionQuestions, { answers: [{ ...tier, choice: 'huge' }, effort] })).toBeUndefined()
  expect(answersOf(jev, sessionQuestions, { answers: [{ type: 'refusal', name: 'tier' }, effort] })).toBeUndefined()
  expect(answersOf(jev, sessionQuestions, { answers: { tier: { value: 'large' } } })).toBeUndefined()
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
