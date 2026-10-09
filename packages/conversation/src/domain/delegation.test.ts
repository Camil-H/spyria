import { expect, test } from 'bun:test'
import { reachableModelsOf } from '@hq/kernel'
import { askedChoiceOf } from './delegation.ts'

const anthropicModels = reachableModelsOf(['anthropic'])
const smallOnly = anthropicModels.filter((model) => model.tier === 'small')

test('an asked model the keys reach is used as asked', () => {
  expect(askedChoiceOf(anthropicModels, 'Opus 5.5', 'Bob')).toEqual({
    model: 'anthropic/claude-opus-5-5',
    reason: 'asked',
  })
  expect(askedChoiceOf(anthropicModels, 'claude-haiku-4-5', 'Bob')).toEqual({
    model: 'anthropic/claude-haiku-4-5',
    reason: 'asked',
  })
  expect(askedChoiceOf(anthropicModels, 'medium', 'Bob')).toEqual({
    model: 'anthropic/claude-sonnet-5-5',
    reason: 'asked',
  })
})

test('an unreachable asked model or tier falls back to the nearest reachable one and says so', () => {
  const fallback = "Opus 5.5 isn't reachable with Bob's keys; used Haiku 4.5"
  expect(askedChoiceOf(smallOnly, 'Opus 5.5', 'Bob')).toEqual({
    model: 'anthropic/claude-haiku-4-5',
    reason: fallback,
    fallback,
  })
  expect(askedChoiceOf(smallOnly, 'large', 'Bob')?.fallback).toBe(
    "large isn't reachable with Bob's keys; used Haiku 4.5",
  )
  expect(askedChoiceOf(reachableModelsOf(['openai']), 'Sonnet 5.5', 'Bob')?.model).toBe('openai/gpt-5-mini')
})

test('no asked model, or an unknown one, leaves the choice to the policy and the classifier', () => {
  expect(askedChoiceOf(anthropicModels, undefined, 'Bob')).toBeUndefined()
  expect(askedChoiceOf(anthropicModels, 'a model nobody lists', 'Bob')).toBeUndefined()
})
