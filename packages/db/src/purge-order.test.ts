import { expect, test } from 'bun:test'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import * as tables from './postgres/tables.ts'
import { workspaceTablesInPurgeOrder } from './server-writes.ts'

const configs = (Object.values(tables) as unknown[])
  .filter(
    (value): value is PgTable =>
      typeof value === 'object' && value !== null && Symbol.for('drizzle:IsDrizzleTable') in value,
  )
  .map((table) => getTableConfig(table))
const workspaceTables = configs.filter(({ columns }) => columns.some(({ name }) => name === 'workspace_id'))

test('the purge erases every table that carries a workspace_id', () => {
  expect([...workspaceTablesInPurgeOrder].toSorted()).toEqual(
    workspaceTables.map(({ name }) => name).toSorted() as never,
  )
})

test('the purge erases every table before the tables it references', () => {
  const positionOf = (name: string) => workspaceTablesInPurgeOrder.indexOf(name as never)
  const referencedTooEarly = workspaceTables.flatMap(({ name, foreignKeys }) =>
    foreignKeys
      .map((foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name)
      .filter(
        (referenced) => referenced !== name && positionOf(referenced) < positionOf(name) && positionOf(referenced) >= 0,
      )
      .map((referenced) => `${name} -> ${referenced}`),
  )
  expect(referencedTooEarly).toEqual([])
})
