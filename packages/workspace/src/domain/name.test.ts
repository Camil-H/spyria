import { expect, test } from 'bun:test'
import { BlankName } from './errors.ts'
import { Name } from './name.ts'

const nameOrErrorOf = (text: string) => {
  try {
    return String(Name(text))
  } catch (error) {
    return error
  }
}

test.each([
  ['  Billing  ', 'Billing'],
  ['   ', expect.any(BlankName)],
])('Name(%p) is trimmed or rejected as blank', (text, expected) => {
  expect(nameOrErrorOf(text)).toEqual(expected)
})
