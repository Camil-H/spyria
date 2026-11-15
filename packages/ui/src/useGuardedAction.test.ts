import { expect, spyOn, test } from 'bun:test'
import { DomainError } from '@spyria/kernel'
import { failureOfAttempt, unexpectedFailureMessage } from './useGuardedAction.ts'

test('a successful action has no failure', async () => {
  expect(await failureOfAttempt(() => Promise.resolve('sent'))).toBeNull()
})

test('a refused action shows its own message', async () => {
  const refusal = new DomainError('budget.exceeded', 'Your budget is spent')
  expect(await failureOfAttempt(() => Promise.reject(refusal))).toBe('Your budget is spent')
})

test('any other failure is a failure too, with a plain message instead of the technical one', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await failureOfAttempt(() => Promise.reject(new TypeError('Failed to fetch')))).toBe(
      unexpectedFailureMessage,
    )
    expect(
      await failureOfAttempt(() => {
        throw 'offline'
      }),
    ).toBe(unexpectedFailureMessage)
  } finally {
    consoleError.mockRestore()
  }
})
