import { createDatabase } from '@hq/db/postgres'
import { setModelDirectory } from '@hq/db/server-writes'
import { addRoutableModels } from '@hq/kernel'
import { createLlmGateway } from '@hq/profile/server'
import { createBifrostUsageLogs } from '@hq/usage/server'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from './app.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { createFakeLlm, fakeRoutableModels } from './fake-llm.ts'
import { readHqAgentImage } from './hq-agent-image.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const authModes = ['dex', 'sso'] as const
const authMode = authModes.find((mode) => mode === (process.env.HQ_AUTH_MODE ?? 'dex'))
if (!authMode) throw new Error('HQ_AUTH_MODE must be dex or sso')
const database = createDatabase()
const gatewaySettings = {
  url: requiredEnvironment('HQ_GATEWAY_URL'),
  adminUser: requiredEnvironment('HQ_GATEWAY_ADMIN_USER'),
  adminPassword: requiredEnvironment('HQ_GATEWAY_ADMIN_PASSWORD'),
}
const llmGateway = createLlmGateway(gatewaySettings)
const hqAgentImage = await readHqAgentImage()
const runtimeHosts = createRuntimeHostGateway({
  hqAgentImage,
  databases: () => [database],
  afterHello: (helloDatabase, host) => agentBridge.forDatabase(helloDatabase).resumeHost(host),
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const llmModel = process.env.HQ_LLM_MODEL
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  hqAgentImage,
  llm: llmModel ? { model: llmModel } : undefined,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
})
const app = createApp({
  database,
  tokenSecret: requiredEnvironment('HQ_TOKEN_SECRET'),
  oidc: {
    issuer: authMode === 'dex' ? requiredEnvironment('HQ_OIDC_ISSUER') : '',
    clientId: authMode === 'dex' ? requiredEnvironment('HQ_OIDC_CLIENT_ID') : '',
    redirectUri: requiredEnvironment('HQ_OIDC_REDIRECT_URI'),
  },
  authMode,
  secretsKey: authMode === 'sso' ? requiredEnvironment('HQ_SECRETS_KEY') : process.env.HQ_SECRETS_KEY,
  mail: process.env.HQ_SMTP_URL
    ? { smtpUrl: process.env.HQ_SMTP_URL, from: requiredEnvironment('HQ_MAIL_FROM') }
    : undefined,
  appOrigin: requiredEnvironment('HQ_APP_ORIGIN'),
  llmGateway,
  runtimeHosts,
  agentBridge,
  hqAgentImage,
  fakeLlm: llmModel ? undefined : createFakeLlm(() => undefined),
})
setModelDirectory(llmGateway.listedModels)
void llmGateway.refreshListedModels()
if (!llmModel) {
  addRoutableModels(fakeRoutableModels)
  await llmGateway
    .registerFakeProviders('http://host.docker.internal:3000/fake-llm')
    .catch((error) => console.error(`Registering the fake LLM in the gateway failed: ${error.message}`))
}
startJobWorker(database, {
  sandboxProvider: runtimeHosts.sandboxProvider,
  agentBridge,
  llmGateway,
  usageLogs: createBifrostUsageLogs(gatewaySettings),
})
await enqueueSweeps(database)
await agentBridge.forDatabase(database).resumeActiveTurns()

export default { port: 3000, hostname: '0.0.0.0', fetch: app.fetch, websocket }
