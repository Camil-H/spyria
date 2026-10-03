import { afterAll, expect, test } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import { allTables } from './seed.ts'
import { createTestDatabase, migrateDatabase } from './test-database.ts'

const emptyDatabase = await createTestDatabase('template0')
afterAll(() => emptyDatabase.drop())

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
