import { afterAll, expect, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import { schema } from '../zero.ts'
import { allTables } from './seed.ts'
import { createTestDatabase, databaseDropTimeoutMilliseconds, migrateDatabase } from './testing.ts'

const emptyDatabase = await createTestDatabase('template0')
afterAll(() => emptyDatabase.drop(), databaseDropTimeoutMilliseconds)

const publicTableNames = async (condition: string) => {
  const rows = await emptyDatabase.database.$client.unsafe<{ table_name: string }[]>(
    `select table_name from information_schema.tables where table_schema = 'public' ${condition} order by table_name`,
  )
  return rows.map((row) => row.table_name)
}

test('migrations apply from scratch and create every table of the schema', async () => {
  await migrateDatabase(emptyDatabase.database)
  expect(await publicTableNames('')).toEqual(allTables.map((table) => getTableName(table)).sort())
})

test('every table except users carries a non-null workspace_id', async () => {
  expect(
    await publicTableNames(
      `and table_name not in (select table_name from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id' and is_nullable = 'NO')`,
    ),
  ).toEqual(['users'])
})

test('the zero publication replicates exactly the tables and columns of the Zero schema', async () => {
  const published = await emptyDatabase.database.$client<{ tablename: string; attnames: string[] }[]>`
    select tablename, attnames from pg_publication_tables where pubname = 'hq_zero' order by tablename`
  const replicated = Object.values(schema.tables).map((table) => ({
    tablename: 'serverName' in table ? table.serverName : table.name,
    attnames: Object.entries(table.columns).map(([name, column]) =>
      'serverName' in column ? column.serverName : name,
    ),
  }))
  const sortedColumns = (tables: { tablename: string; attnames: string[] }[]) =>
    tables
      .map(({ tablename, attnames }) => ({ tablename, attnames: attnames.toSorted() }))
      .toSorted((first, second) => first.tablename.localeCompare(second.tablename))
  expect(sortedColumns(published)).toEqual(sortedColumns(replicated))
})
