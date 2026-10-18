import { createDatabase, type Database } from '@hq/db/postgres'
import { databaseUrlOf } from '@hq/db/testing'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { testAuthSettings, testSecretsKey } from './testing.ts'

const port = Number(process.env.PORT ?? 3102)
const databaseByName = new Map<string, Database>()
const databaseNamed = (databaseName: string) => {
  const known = databaseByName.get(databaseName)
  if (known) return known
  const database = createDatabase(databaseUrlOf(databaseName))
  databaseByName.set(databaseName, database)
  return database
}

const app = createApp({
  database: createDatabase(),
  ...testAuthSettings,
  appOrigin: process.env.HQ_APP_ORIGIN ?? 'http://localhost:5191',
  oidc: { ...testAuthSettings.oidc, redirectUri: `http://localhost:${port}/auth/callback` },
  authMode: 'sso',
  secretsKey: testSecretsKey,
  testDatabaseByName: databaseNamed,
})

export default { port, hostname: '0.0.0.0', idleTimeout: 0, fetch: app.fetch, websocket }
