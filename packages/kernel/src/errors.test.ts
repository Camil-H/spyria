import { expect, test } from 'bun:test'
import { Glob } from 'bun'
import {
  blankKind,
  ChatNotFound,
  DomainError,
  disclosableMessageOf,
  domainErrorOf,
  errorKind,
  errorSummaryOf,
  nonBlank,
  refusalOf,
} from './errors.ts'

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

test('a non-blank value is trimmed, and a blank one is refused with its own kind', () => {
  const BlankTitle = blankKind('blank_title', 'A title', DomainError)
  expect(nonBlank('  Launch plan ', BlankTitle)).toBe('Launch plan')
  expect(() => nonBlank(' \n ', BlankTitle)).toThrow(BlankTitle)
  expect(() => nonBlank('', BlankTitle)).toThrow('A title must contain at least one non-blank character')
})

test('a refusal read back from its code and message is its own kind again, and an unknown code a domain error', () => {
  const ChatArchived = errorKind('chat_archived', () => 'This chat is archived', DomainError)
  const revived = domainErrorOf('chat_archived', 'This chat is archived')
  expect(revived).toBeInstanceOf(ChatArchived)
  expect([revived.code, revived.message]).toEqual(['chat_archived', 'This chat is archived'])
  expect(domainErrorOf('chat_not_found', 'Chat chat-1 was not found')).toBeInstanceOf(ChatNotFound)
  const unknown = domainErrorOf('not_a_known_code', 'Refused')
  expect([unknown.constructor, unknown.code, unknown.message]).toEqual([DomainError, 'not_a_known_code', 'Refused'])
  expect(refusalOf(502, {})).toMatchObject({ code: 'internal', message: 'The request was refused with 502' })
})

test('every error code is declared once across the packages, so a code read back names one kind', async () => {
  const declaredCodes: string[] = []
  for await (const path of new Glob('packages/*/src/**/*.ts').scan(`${import.meta.dir}/../../..`))
    if (!path.endsWith('.test.ts'))
      for (const [, code] of (await Bun.file(`${import.meta.dir}/../../../${path}`).text()).matchAll(
        /(?:errorKind|blankKind)\(\s*'([a-z_]+)'/g,
      ))
        declaredCodes.push(code as string)
  expect(declaredCodes.length).toBeGreaterThan(100)
  expect(declaredCodes.filter((code, index) => declaredCodes.indexOf(code) !== index)).toEqual([])
})
