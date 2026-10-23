import { createDatabase } from '@spyria/db/postgres'
import { setModelDirectory } from '@spyria/db/server-writes'
import { deploymentOf } from '@spyria/kernel'
import { createLlmGateway } from '@spyria/profile/server'
import { createBifrostUsageLogs } from '@spyria/usage/server'
import { createAgentBridge } from './agent-bridge/bridge.ts'
import { createApp, sessionClassifierOf } from './app.ts'
import { createSecretBox } from './auth/secret-box.ts'
import { enqueueSweeps } from './auth/sessions.ts'
import { assertInstanceAppsConfigured } from './auth/sso.ts'
import { createGitHubCheckouts } from './github/github.ts'
import { createGitHubApi, githubDotCom } from './github/github-api.ts'
import { startJobWorker } from './job-worker.ts'
import { createModelCallRelay } from './llm-relay.ts'
import { productionProblemsOf } from './production.ts'
import { createRuntimeHostGateway, serverWebSocket } from './runtime-hosts/gateway.ts'
import { readSpyriaAgentImage } from './spyria-agent-image.ts'
import { startTelemetry } from './telemetry.ts'

const productionProblems = productionProblemsOf(process.env)
if (productionProblems.length > 0) {
  console.error(`Spyria cannot start in production:\n${productionProblems.map((problem) => `- ${problem}`).join('\n')}`)
  process.exit(1)
}

const requiredEnvironment = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}
const instanceSignInAppOf = (preset: 'google' | 'microsoft', clientIdName: string, clientSecretName: string) => {
  const clientId = process.env[clientIdName]
  if (!clientId) return {}
  return { [preset]: { clientId, clientSecret: requiredEnvironment(clientSecretName) } }
}

const telemetry = startTelemetry()
const shutdownMilliseconds = 25_000
const authModes = ['dex', 'sso'] as const
const authMode = authModes.find((mode) => mode === (process.env.SPYRIA_AUTH_MODE ?? 'dex'))
if (!authMode) throw new Error('SPYRIA_AUTH_MODE must be dex or sso')
const deployment = deploymentOf(process.env.SPYRIA_DEPLOYMENT)
const database = createDatabase()
const gatewaySettings = {
  url: requiredEnvironment('SPYRIA_GATEWAY_URL'),
  adminUser: requiredEnvironment('SPYRIA_GATEWAY_ADMIN_USER'),
  adminPassword: requiredEnvironment('SPYRIA_GATEWAY_ADMIN_PASSWORD'),
}
const llmGateway = createLlmGateway(gatewaySettings)
const tokenSecret = requiredEnvironment('SPYRIA_TOKEN_SECRET')
const spyriaAgentImage = await readSpyriaAgentImage()
const runtimeHosts = createRuntimeHostGateway({
  spyriaAgentImage,
  runtimeKeySecret: tokenSecret,
  databases: () => [database],
  afterHello: (helloDatabase, host) => agentBridge.forDatabase(helloDatabase).resumeHost(host),
  relayModelCall: createModelCallRelay({ llmGateway, agentBridge: () => agentBridge }),
})
const secretsKey = authMode === 'sso' ? requiredEnvironment('SPYRIA_SECRETS_KEY') : process.env.SPYRIA_SECRETS_KEY
const github = {
  api: createGitHubApi(githubDotCom),
  secretBox: secretsKey ? createSecretBox(secretsKey) : undefined,
}
const agentBridge = createAgentBridge({
  sandboxProvider: runtimeHosts.sandboxProvider,
  spyriaAgentImage,
  sessionClassifierOf: sessionClassifierOf(llmGateway),
  repositoryCheckoutsOf: (checkoutDatabase) => createGitHubCheckouts(checkoutDatabase, github),
  deployment,
})
const instanceSignInApps = {
  ...instanceSignInAppOf('google', 'SPYRIA_GOOGLE_CLIENT_ID', 'SPYRIA_GOOGLE_CLIENT_SECRET'),
  ...instanceSignInAppOf('microsoft', 'SPYRIA_MICROSOFT_CLIENT_ID', 'SPYRIA_MICROSOFT_CLIENT_SECRET'),
}
await assertInstanceAppsConfigured(database, instanceSignInApps)
const app = createApp({
  database,
  tokenSecret,
  oidc: {
    issuer: authMode === 'dex' ? requiredEnvironment('SPYRIA_OIDC_ISSUER') : '',
    clientId: authMode === 'dex' ? requiredEnvironment('SPYRIA_OIDC_CLIENT_ID') : '',
    redirectUri: requiredEnvironment('SPYRIA_OIDC_REDIRECT_URI'),
  },
  authMode,
  secretsKey,
  instanceSignInApps,
  github,
  mail: process.env.SPYRIA_SMTP_URL
    ? { smtpUrl: process.env.SPYRIA_SMTP_URL, from: requiredEnvironment('SPYRIA_MAIL_FROM') }
    : undefined,
  appOrigin: requiredEnvironment('SPYRIA_APP_ORIGIN'),
  deployment,
  webDist: process.env.SPYRIA_WEB_DIST || undefined,
  llmGateway,
  runtimeHosts,
  agentBridge,
  spyriaAgentImage,
  trustedProxy: process.env.SPYRIA_TRUSTED_PROXY === 'cloudflare' ? 'cloudflare' : undefined,
})
setModelDirectory(llmGateway.listedModels)
void llmGateway.refreshListedModels()
const jobWorker = startJobWorker(database, {
  sandboxProvider: runtimeHosts.sandboxProvider,
  agentBridge,
  llmGateway,
  usageLogs: createBifrostUsageLogs(gatewaySettings),
})
await enqueueSweeps(database)
await agentBridge.forDatabase(database).resumeActiveTurns()
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: '0.0.0.0',
  fetch: app.fetch,
  websocket: serverWebSocket,
})

const shutDown = async () => {
  setTimeout(() => process.exit(1), shutdownMilliseconds).unref()
  void server.stop()
  await jobWorker.stop()
  await runtimeHosts.close()
  await server.stop(true)
  await database.$client.end({ timeout: 5 })
  await telemetry.shutdown()
  process.exit(0)
}
process.once('SIGTERM', shutDown)
process.once('SIGINT', shutDown)
