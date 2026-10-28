import { expect, test } from 'bun:test'
import { contextFullnessOf } from './context-size.ts'

test('the context is as full as the latest call’s tokens are of the model’s window, nearly full from 80%', () => {
  expect(contextFullnessOf({ tokens: 45_210, window: 200_000 })).toEqual({
    percent: 23,
    isNearlyFull: false,
    shown: '23%',
    label: 'Context: 23% full, 45,210 of 200,000 tokens',
  })
  expect(contextFullnessOf({ tokens: 160_000, window: 200_000 })).toMatchObject({ percent: 80, isNearlyFull: true })
  expect(contextFullnessOf({ tokens: 260_000, window: 200_000 })).toMatchObject({ percent: 100, isNearlyFull: true })
})

test('without a known window the context shows its tokens only', () => {
  expect(contextFullnessOf({ tokens: 3_412, window: null })).toEqual({
    percent: null,
    isNearlyFull: false,
    shown: '3.4K',
    label: 'Context: 3,412 tokens',
  })
  expect(contextFullnessOf({ tokens: 10, window: 0 })).toMatchObject({ percent: null })
})
