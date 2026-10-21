import { createDatabase, type Database } from '@spyria/db/postgres'
import { databaseUrlOf } from '@spyria/db/testing'
import { createApp } from '../app.ts'
import { serverWebSocket } from '../runtime-hosts/gateway.ts'
import { startFakeSmtp } from './fake-smtp.ts'
import { testAuthSettings, testSecretsKey } from './testing.ts'

const port = Number(process.env.PORT ?? 3102)
const smtp = startFakeSmtp()
const databaseByName = new Map<string, Database>()
const databaseNamed = (databaseName: string) => {
  const known = databaseByName.get(databaseName)
  if (known) return known
  const database = createDatabase(databaseUrlOf(databaseName))
  databaseByName.set(databaseName, database)
  return database
}

const app = createApp({
  database: createDatabase(databaseUrlOf('postgres')),
  ...testAuthSettings,
  appOrigin: process.env.SPYRIA_APP_ORIGIN ?? 'http://localhost:5191',
  oidc: { ...testAuthSettings.oidc, redirectUri: `http://localhost:${port}/auth/callback` },
  authMode: 'sso',
  secretsKey: testSecretsKey,
  testDatabaseByName: databaseNamed,
  mail: { smtpUrl: smtp.url, from: 'Spyria <spyria@e2e.test>' },
}).get('/test/mails', (context) => context.json(smtp.mails))

export default { port, hostname: '0.0.0.0', idleTimeout: 0, fetch: app.fetch, websocket: serverWebSocket }
