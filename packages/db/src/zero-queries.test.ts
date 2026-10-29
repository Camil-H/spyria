import { expect, test } from 'bun:test'
import type { Transaction } from '@rocicorp/zero'
import { DomainError } from '@spyria/kernel'
import { caseVariantsOf, likeEscaped, queries, transactorOver, type ZeroContext } from './zero-queries.ts'

const transactionOf = (location: string, reason: string) => ({ location, reason }) as Transaction
const runOn = (tx: Transaction, work: () => Promise<unknown>) => transactorOver(tx, {}).run(work)
const probeContext = { userId: 'member-probe', workspaceId: 'workspace-probe' } as ZeroContext
const queryOutcomeWithoutArguments = (name: string, query: { fn: (options: never) => unknown }) => {
  try {
    query.fn({ ctx: probeContext, args: undefined } as never)
    return 'takes no arguments'
  } catch (error) {
    return (error as Error).message.startsWith(`Validation failed for query ${name}`)
      ? 'validates its arguments'
      : String(error)
  }
}
const refused = () => Promise.reject(new DomainError('not_participant', 'This member is not in the chat'))

test('a refusal on a client rebase skips the mutation, so the server answer decides', async () => {
  expect(await runOn(transactionOf('client', 'rebase'), refused)).toBeUndefined()
})

test('a refusal stays an error when optimistic, on the server, or when it is not a domain error', async () => {
  await expect(runOn(transactionOf('client', 'optimistic'), refused)).rejects.toThrow('This member is not in the chat')
  await expect(runOn(transactionOf('server', 'authoritative'), refused)).rejects.toThrow(
    'This member is not in the chat',
  )
  await expect(runOn(transactionOf('client', 'rebase'), () => Promise.reject(new Error('disk full')))).rejects.toThrow(
    'disk full',
  )
})

test('a searched text matches its wildcards and backslashes literally', () => {
  expect(likeEscaped('50% off_now')).toBe('50\\% off\\_now')
  expect(likeEscaped('C:\\temp')).toBe('C:\\\\temp')
  expect(likeEscaped('plain words')).toBe('plain words')
})

test('a searched text with accented letters also tries its title and upper case, which SQLite lower() leaves as they are', () => {
  expect(caseVariantsOf('été indien')).toEqual(['été indien', 'Été Indien', 'ÉTÉ INDIEN'])
  expect(caseVariantsOf('Deploy Notes')).toEqual(['deploy notes'])
})

test('every synced query either takes no arguments or validates them before it builds a query', () => {
  const outcomes = Object.entries(queries).flatMap(([name, query]) =>
    typeof query === 'string' ? [] : [[name, queryOutcomeWithoutArguments(name, query)]],
  )
  expect(
    outcomes.filter(([, outcome]) => outcome !== 'takes no arguments' && outcome !== 'validates its arguments'),
  ).toEqual([])
  expect(outcomes.filter(([, outcome]) => outcome === 'validates its arguments').length).toBeGreaterThan(0)
})
