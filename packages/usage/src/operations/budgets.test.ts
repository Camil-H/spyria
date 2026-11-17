import { expect, test } from 'bun:test'
import { memberId } from '@spyria/kernel'
import type { BudgetLedger } from '../contracts/budgets.ts'
import { findUsedUpBudget } from './budgets.ts'

const alice = memberId('member-alice')

const ledgerWith = (hasBudget: boolean) => {
  const spendReads: (string | null)[] = []
  const ledger: Pick<BudgetLedger, 'hasBudget' | 'memberSpends'> = {
    hasBudget: async () => hasBudget,
    memberSpends: async (_periodStarts, reader) => {
      spendReads.push(reader)
      return [{ memberId: alice, name: 'Alice', period: 'month', limitMicros: 1, spentMicros: 2 }]
    },
  }
  return {
    transactor: { run: <Result>(work: (unitOfWork: BudgetLedger) => Promise<Result>) => work(ledger as BudgetLedger) },
    spendReads,
  }
}

test('the budget guard reads no spend for a member whose role has no budget, and finds the used-up period otherwise', async () => {
  const unlimited = ledgerWith(false)
  expect(await findUsedUpBudget(unlimited, { memberId: alice, now: new Date() })).toBeNull()
  expect(unlimited.spendReads).toEqual([])
  const limited = ledgerWith(true)
  expect(await findUsedUpBudget(limited, { memberId: alice, now: new Date() })).toBe('month')
  expect(limited.spendReads).toEqual([alice])
})
