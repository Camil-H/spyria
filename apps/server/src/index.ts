import { createDatabase } from '@hq/db/postgres'
import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { enqueueSessionSweeps } from './auth/sessions.ts'
import { startJobWorker } from './job-worker.ts'

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const database = createDatabase()
const app = createApp({
  database,
  tokenSecret: requiredEnvironment('HQ_TOKEN_SECRET'),
  oidc: {
    issuer: requiredEnvironment('HQ_OIDC_ISSUER'),
    clientId: requiredEnvironment('HQ_OIDC_CLIENT_ID'),
    redirectUri: requiredEnvironment('HQ_OIDC_REDIRECT_URI'),
  },
  appOrigin: requiredEnvironment('HQ_APP_ORIGIN'),
})
startJobWorker(database)
await enqueueSessionSweeps(database)

export default { port: 3000, hostname: '0.0.0.0', fetch: app.fetch, websocket }
