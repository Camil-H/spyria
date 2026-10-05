import { createDatabase } from '@hq/db/postgres'
import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { startJobWorker } from './job-worker.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const database = createDatabase()
const runtimeHosts = createRuntimeHostGateway({ databases: () => [database] })
const app = createApp({
  database,
  tokenSecret: requiredEnvironment('HQ_TOKEN_SECRET'),
  oidc: {
    issuer: requiredEnvironment('HQ_OIDC_ISSUER'),
    clientId: requiredEnvironment('HQ_OIDC_CLIENT_ID'),
    redirectUri: requiredEnvironment('HQ_OIDC_REDIRECT_URI'),
  },
  appOrigin: requiredEnvironment('HQ_APP_ORIGIN'),
  runtimeHosts,
})
startJobWorker(database, { sandboxProvider: runtimeHosts.sandboxProvider })
await enqueueSweeps(database)

export default { port: 3000, hostname: '0.0.0.0', fetch: app.fetch, websocket }
