import { createDatabase } from '@hq/db/postgres'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, defaultLlm } from './app.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { createFakeLlm } from './fake-llm.ts'
import { startJobWorker } from './job-worker.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const database = createDatabase()
const runtimeHosts = createRuntimeHostGateway({ databases: () => [database] })
const llmBaseUrl = process.env.HQ_LLM_BASE_URL
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  llm: { baseUrl: llmBaseUrl ?? defaultLlm.baseUrl, model: process.env.HQ_LLM_MODEL ?? defaultLlm.model },
})
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
  agentBridge,
  fakeLlm: llmBaseUrl ? undefined : createFakeLlm(() => undefined),
})
startJobWorker(database, { sandboxProvider: runtimeHosts.sandboxProvider, agentBridge })
await enqueueSweeps(database)
await agentBridge.forDatabase(database).resumeActiveTurns()

export default { port: 3000, hostname: '0.0.0.0', fetch: app.fetch, websocket }
