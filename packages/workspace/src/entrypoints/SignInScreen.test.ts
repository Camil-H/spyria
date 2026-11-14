import { expect, spyOn, test } from 'bun:test'
import { unexpectedFailureMessage } from '@spyria/ui'
import { outcomeOrFailureOf } from './SignInScreen.tsx'

test('a sign-in that answers keeps its outcome', async () => {
  expect(await outcomeOrFailureOf(async () => ({ status: 'not_invited', email: 'pat@example.com' }))).toEqual({
    status: 'not_invited',
    email: 'pat@example.com',
  })
})

test('a sign-in that fails, such as when the server cannot be reached, is refused with a plain message so it can be tried again', async () => {
  const consoleError = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(await outcomeOrFailureOf(() => Promise.reject(new TypeError('Failed to fetch')))).toEqual({
      status: 'refused',
      message: unexpectedFailureMessage,
    })
  } finally {
    consoleError.mockRestore()
  }
})
