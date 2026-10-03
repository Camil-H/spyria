import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createDatabase, databaseUrl } from './client.ts'
import { seedDatabase } from './seed.ts'

export const templateDatabaseName = 'hq_test_template'

const urlOf = (databaseName: string) => Object.assign(new URL(databaseUrl), { pathname: `/${databaseName}` }).href

const withAdmin = async (statement: string) => {
  const admin = postgres(urlOf('postgres'), { onnotice: () => {} })
  await admin.unsafe(statement)
  await admin.end()
}

export const migrateDatabase = (database: ReturnType<typeof createDatabase>) =>
  migrate(database, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })

export const createTestDatabase = async (template = templateDatabaseName) => {
  const name = `hq_test_${crypto.randomUUID().replaceAll('-', '')}`
  await withAdmin(`create database "${name}" template "${template}"`)
  const database = createDatabase(urlOf(name))
  return {
    database,
    drop: async () => {
      await database.$client.end()
      await withAdmin(`drop database "${name}" with (force)`)
    },
  }
}

export const buildTemplateDatabase = async () => {
  await withAdmin(`drop database if exists "${templateDatabaseName}" with (force)`)
  await withAdmin(`create database "${templateDatabaseName}"`)
  const database = createDatabase(urlOf(templateDatabaseName))
  await migrateDatabase(database)
  await seedDatabase(database)
  await database.$client.end()
}
