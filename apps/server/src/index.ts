import { createDatabase } from '@spyria/db/postgres'
import { setModelDirectory } from '@spyria/db/server-writes'
import { addRoutableModels } from '@spyria/kernel'
import { createLlmGateway } from '@spyria/profile/server'
import { createBifrostUsageLogs } from '@spyria/usage/server'
import { websocket } from 'hono/bun'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from './app.ts'
import { createSecretBox } from './auth/secret-box.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { createFakeLlm, fakeRoutableModels } from './fake-llm.ts'
import { createGitHubCheckouts } from './github/github.ts'
import { createGitHubApi, githubDotCom } from './github/github-api.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { createRuntimeHostGateway } from './runtime-hosts/gateway.ts'
import { readSpyriaAgentImage } from './spyria-agent-image.ts'

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const authModes = ['dex', 'sso'] as const
const authMode = authModes.find((mode) => mode === (process.env.SPYRIA_AUTH_MODE ?? 'dex'))
if (!authMode) throw new Error('SPYRIA_AUTH_MODE must be dex or sso')
const database = createDatabase()
const gatewaySettings = {
  url: requiredEnvironment('SPYRIA_GATEWAY_URL'),
  adminUser: requiredEnvironment('SPYRIA_GATEWAY_ADMIN_USER'),
  adminPassword: requiredEnvironment('SPYRIA_GATEWAY_ADMIN_PASSWORD'),
}
const llmGateway = createLlmGateway(gatewaySettings)
const spyriaAgentImage = await readSpyriaAgentImage()
const runtimeHosts = createRuntimeHostGateway({
  spyriaAgentImage,
  databases: () => [database],
  afterHello: (helloDatabase, host) => agentBridge.forDatabase(helloDatabase).resumeHost(host),
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const llmModel = process.env.SPYRIA_LLM_MODEL
const secretsKey = authMode === 'sso' ? requiredEnvironment('SPYRIA_SECRETS_KEY') : process.env.SPYRIA_SECRETS_KEY
const github = {
  api: createGitHubApi({
    apiUrl: process.env.SPYRIA_GITHUB_API_URL ?? githubDotCom.apiUrl,
    webUrl: process.env.SPYRIA_GITHUB_WEB_URL ?? githubDotCom.webUrl,
  }),
  secretBox: secretsKey ? createSecretBox(secretsKey) : undefined,
}
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  spyriaAgentImage,
  llm: llmModel ? { model: llmModel } : undefined,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
  repositoryCheckoutsOf: (checkoutDatabase) => createGitHubCheckouts(checkoutDatabase, github),
})
const app = createApp({
  database,
  tokenSecret: requiredEnvironment('SPYRIA_TOKEN_SECRET'),
  oidc: {
    issuer: authMode === 'dex' ? requiredEnvironment('SPYRIA_OIDC_ISSUER') : '',
    clientId: authMode === 'dex' ? requiredEnvironment('SPYRIA_OIDC_CLIENT_ID') : '',
    redirectUri: requiredEnvironment('SPYRIA_OIDC_REDIRECT_URI'),
  },
  authMode,
  secretsKey,
  github,
  mail: process.env.SPYRIA_SMTP_URL
    ? { smtpUrl: process.env.SPYRIA_SMTP_URL, from: requiredEnvironment('SPYRIA_MAIL_FROM') }
    : undefined,
  appOrigin: requiredEnvironment('SPYRIA_APP_ORIGIN'),
  llmGateway,
  runtimeHosts,
  agentBridge,
  spyriaAgentImage,
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
