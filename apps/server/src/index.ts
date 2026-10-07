import { createDatabase } from '@hq/db/postgres'
import { createLlmGateway } from '@hq/profile/server'
import { createBifrostUsageLogs } from '@hq/usage/server'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from './app.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { createFakeLlm } from './fake-llm.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const database = createDatabase()
const gatewaySettings = {
  url: requiredEnvironment('HQ_GATEWAY_URL'),
  adminUser: requiredEnvironment('HQ_GATEWAY_ADMIN_USER'),
  adminPassword: requiredEnvironment('HQ_GATEWAY_ADMIN_PASSWORD'),
}
const llmGateway = createLlmGateway(gatewaySettings)
const runtimeHosts = createRuntimeHostGateway({
  databases: () => [database],
  afterHello: (helloDatabase, host) => agentBridge.forDatabase(helloDatabase).promptWaiting(host),
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const llmModel = process.env.HQ_LLM_MODEL
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  llm: llmModel ? { model: llmModel } : undefined,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
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
  llmGateway,
  runtimeHosts,
  agentBridge,
  fakeLlm: llmModel ? undefined : createFakeLlm(() => undefined),
})
if (!llmModel)
  await llmGateway
    .registerFakeProviders('http://host.docker.internal:3000/fake-llm')
    .catch((error) => console.error(`Registering the fake LLM in the gateway failed: ${error.message}`))
startJobWorker(database, {
  sandboxProvider: runtimeHosts.sandboxProvider,
  agentBridge,
  llmGateway,
  usageLogs: createBifrostUsageLogs(gatewaySettings),
})
await enqueueSweeps(database)
await agentBridge.forDatabase(database).resumeActiveTurns()

export default { port: 3000, hostname: '0.0.0.0', fetch: app.fetch, websocket }
