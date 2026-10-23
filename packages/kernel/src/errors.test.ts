import { expect, test } from 'bun:test'
import { DomainError, disclosableMessageOf, errorSummaryOf } from './errors.ts'

const failedQuery = Object.assign(new Error('Failed query: insert into runtimes values ($1)\nparams: s3cret'), {
  name: 'DrizzleQueryError',
  params: ['s3cret'],
  cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
})

test.each([
  [
    'a domain error keeps its message',
    new DomainError('chat_not_found', 'Chat chat-1 was not found'),
    'Chat chat-1 was not found',
  ],
  ['a failed query keeps its class and the database code', failedQuery, 'DrizzleQueryError 23505'],
  ['any other error keeps its class only', new TypeError('fetch failed for https://user:pass@host'), 'TypeError'],
  ['a thrown value that is not an error', 's3cret', 'unknown error'],
])('the summary stored for a failed job: %s', (_, error, summary) => {
  expect(errorSummaryOf(error)).toBe(summary)
})

test('a disclosable message hides the parameters of a failed query and keeps any other message', () => {
  expect(disclosableMessageOf(failedQuery)).toBe('DrizzleQueryError 23505')
  expect(disclosableMessageOf(new Error('The agent server answered 502'))).toBe('The agent server answered 502')
})
