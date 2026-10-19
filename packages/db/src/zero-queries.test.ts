import { expect, test } from 'bun:test'
import type { Transaction } from '@rocicorp/zero'
import { DomainError } from '@spyria/kernel'
import { skippingRefusedRebase } from './zero-queries.ts'

const transactionOf = (location: string, reason: string) => ({ location, reason }) as Transaction
const refused = () => Promise.reject(new DomainError('not_participant', 'This member is not in the chat'))

test('a refusal on a client rebase skips the mutation, so the server answer decides', async () => {
  expect(await skippingRefusedRebase(transactionOf('client', 'rebase'), refused)).toBeUndefined()
})

test('a refusal stays an error when optimistic, on the server, or when it is not a domain error', async () => {
  await expect(skippingRefusedRebase(transactionOf('client', 'optimistic'), refused)).rejects.toThrow(
    'This member is not in the chat',
  )
  await expect(skippingRefusedRebase(transactionOf('server', 'authoritative'), refused)).rejects.toThrow(
    'This member is not in the chat',
  )
  await expect(
    skippingRefusedRebase(transactionOf('client', 'rebase'), () => Promise.reject(new Error('disk full'))),
  ).rejects.toThrow('disk full')
})
