import { defineConfig } from 'drizzle-kit'
import { databaseUrl } from './src/postgres/client.ts'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/postgres/tables.ts',
  out: './drizzle',
  dbCredentials: { url: `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}search_path=public` },
})
