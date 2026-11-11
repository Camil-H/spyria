import type { Database } from '@spyria/db/postgres'
import type { SecretBox } from './auth/secret-box.ts'

const sealedColumns = [
  { table: 'workspace_sso', keys: ['workspace_id'], columns: ['encrypted_client_secret'] },
  {
    table: 'github_apps',
    keys: ['workspace_id'],
    columns: ['encrypted_client_secret', 'encrypted_private_key', 'encrypted_webhook_secret'],
  },
  {
    table: 'github_connections',
    keys: ['workspace_id', 'user_id'],
    columns: ['encrypted_access_token', 'encrypted_refresh_token'],
  },
] as const

export const resealSecrets = async (database: Database, secretBox: SecretBox) => {
  const sql = database.$client
  let resealedCount = 0
  for (const { table, keys, columns } of sealedColumns)
    for (const column of columns) {
      const rows = await sql<Record<string, string>[]>`
        select ${sql(keys)}, ${sql(column)} as sealed from ${sql(table)} where ${sql(column)} <> ''`
      for (const row of rows.filter(({ sealed = '' }) => !secretBox.isSealedWithCurrentKey(sealed))) {
        const sameRow = keys.reduce(
          (condition, key) => sql`${condition} and ${sql(key)} = ${row[key] ?? ''}`,
          sql`true`,
        )
        const { count } = await sql`
          update ${sql(table)} set ${sql(column)} = ${await secretBox.reseal(row.sealed ?? '')}
          where ${sameRow} and ${sql(column)} = ${row.sealed ?? ''}`
        resealedCount += count
      }
    }
  return resealedCount
}

export const countRuntimesRunningOnPreviousKeys = async (database: Database, currentKeyId: string) => {
  const [row] = await database.$client<{ count: number }[]>`
    select count(*)::int as count from runtimes where state = 'running' and api_key_id is distinct from ${currentKeyId}`
  return row?.count ?? 0
}
