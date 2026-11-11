import { ZQLDatabase } from '@rocicorp/zero/server'
import { type PostgresJsTransaction, PostgresJsTransactionInternal } from '@rocicorp/zero/server/adapters/postgresjs'
import { schema } from '../zero.ts'
import type { Transact } from '../zero-queries.ts'
import type { Database } from './client.ts'

type Sql = Parameters<Parameters<Database['$client']['begin']>[1]>[0]

export const transactWithin = (sql: Sql): Transact => {
  // Zero pins its own postgres.js release: its transaction type names the same API as ours
  const transaction = new PostgresJsTransactionInternal(sql as unknown as PostgresJsTransaction)
  const database = new ZQLDatabase({ transaction: (work) => work(transaction) }, schema)
  return (work) => database.transaction(work)
}
