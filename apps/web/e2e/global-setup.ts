import { execFile, execSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createDatabase } from '@hq/db/postgres'
import {
  buildTemplateDatabase,
  databaseUrlOf,
  dropDatabase,
  httpStatusOf,
  startTestGateway,
  testGatewayAdmin,
} from '@hq/db/testing'
import {
  fakeMcpUrl,
  gatewayPort,
  gatewayUrl,
  maximumWorkerCount,
  serverUrl,
  ssoProviderIssuer,
  ssoServerUrl,
  ssoViteUrl,
  templateDatabaseName,
  viteUrl,
  zeroCachePortOf,
} from './stack-ports.ts'

const repositoryRoot = new URL('../../../', import.meta.url).pathname
const e2eBuild = ['--mode', 'e2e', '--outDir', 'node_modules/.e2e-dist']

const sweptPorts = [
  new URL(serverUrl).port,
  new URL(viteUrl).port,
  new URL(fakeMcpUrl).port,
  new URL(ssoServerUrl).port,
  new URL(ssoViteUrl).port,
  ...Array.from({ length: maximumWorkerCount }, (_, index) => [
    zeroCachePortOf(index),
    zeroCachePortOf(index) + 1,
  ]).flat(),
]
const sweptListeners = () =>
  execSync(`lsof -t -iTCP:${sweptPorts.join(',')} -sTCP:LISTEN || true`)
    .toString()
    .split('\n')
    .filter(Boolean)

const sweepLeftovers = async () => {
  for (const processId of sweptListeners()) process.kill(Number(processId), 'SIGTERM')
  for (let attempt = 1; sweptListeners().length > 0; attempt++) {
    if (attempt === 100) throw new Error(`Ports ${sweptPorts.join(', ')} are still in use`)
    await sleep(100)
  }
  const admin = createDatabase(databaseUrlOf('postgres')).$client
  const leftoverDatabases = await admin<{ name: string }[]>`
    select datname as name from pg_database where datname like 'hq\\_e2e\\_w%'`
  await admin.end()
  for (const { name } of leftoverDatabases) await dropDatabase(name)
  removeWorkerHosts()
}

const removeWorkerHosts = () => {
  execSync(`pkill -f '${repositoryRoot}apps/host/src/main.ts ${serverUrl}/h/' || true`)
}

const startDetached = async (command: string[], cwd: string, env: Record<string, string>, readyUrl: string) => {
  const [executable = '', ...args] = command
  const logFile = openSync(join(tmpdir(), `hq-e2e-${new URL(readyUrl).port}.log`), 'w')
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', logFile, logFile],
  })
  for (let attempt = 1; (await httpStatusOf(readyUrl)) !== 200; attempt++) {
    if (attempt === 400) throw new Error(`${command.join(' ')} did not start`)
    await sleep(50)
  }
  return () => process.kill(-(child.pid ?? 0), 'SIGTERM')
}

const ssoDexContainer = 'hq-test-dex-e2e'
const ssoDexConfig = new URL('./dex-sso.yaml', import.meta.url).pathname
const docker = (...args: string[]) => spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })

const startSsoDex = async () => {
  const configHash = createHash('sha256').update(readFileSync(ssoDexConfig)).digest('hex').slice(0, 16)
  const discoveryUrl = `${ssoProviderIssuer}/.well-known/openid-configuration`
  const running = docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "hq.setup"}}', ssoDexContainer)
  if (running.stdout.toString().trim() === `true ${configHash}` && (await httpStatusOf(discoveryUrl)) === 200) return
  docker('rm', '-f', ssoDexContainer)
  const started = docker(
    'run',
    '-d',
    '--name',
    ssoDexContainer,
    '--label',
    `hq.setup=${configHash}`,
    '-p',
    `127.0.0.1:${new URL(ssoProviderIssuer).port}:5556`,
    '-v',
    `${ssoDexConfig}:/etc/dex/config.yaml:ro`,
    'dexidp/dex:v2.43.1',
    'dex',
    'serve',
    '/etc/dex/config.yaml',
  )
  if (started.status !== 0) throw new Error(`Starting ${ssoDexContainer} failed: ${started.stderr}`)
  for (let attempt = 1; (await httpStatusOf(discoveryUrl)) !== 200; attempt++) {
    if (attempt === 400) throw new Error(`${ssoDexContainer} did not start`)
    await sleep(50)
  }
}

export default async function globalSetup() {
  execSync('docker compose -f infra/docker-compose.yml up -d --wait --no-recreate postgres dex', {
    cwd: repositoryRoot,
    stdio: 'ignore',
  })
  await sweepLeftovers()
  const webBuild = promisify(execFile)('bun', ['run', 'build', ...e2eBuild], { cwd: `${repositoryRoot}apps/web` })
  const [, , stopServer, stopVite, stopSsoServer, stopSsoVite] = await Promise.all([
    buildTemplateDatabase(templateDatabaseName),
    startTestGateway({
      name: 'e2e',
      port: gatewayPort,
      fakeLlmUrl: `http://host.docker.internal:${new URL(serverUrl).port}/fake-llm`,
      oauthBase: `${viteUrl}/gateway-oauth`,
    }),
    startDetached(
      ['bun', 'src/testing/test-server.ts'],
      `${repositoryRoot}apps/server`,
      {
        PORT: new URL(serverUrl).port,
        HQ_APP_ORIGIN: viteUrl,
        HQ_GATEWAY_URL: gatewayUrl,
        HQ_GATEWAY_ADMIN_USER: testGatewayAdmin.user,
        HQ_GATEWAY_ADMIN_PASSWORD: testGatewayAdmin.password,
        HQ_FAKE_MCP_PORT: new URL(fakeMcpUrl).port,
      },
      `${serverUrl}/health`,
    ),
    webBuild.then(() =>
      startDetached(
        ['bunx', 'vite', 'preview', ...e2eBuild, '--port', new URL(viteUrl).port],
        `${repositoryRoot}apps/web`,
        { HQ_SERVER_URL: serverUrl },
        viteUrl,
      ),
    ),
    startSsoDex().then(() =>
      startDetached(
        ['bun', 'src/testing/sso-test-server.ts'],
        `${repositoryRoot}apps/server`,
        { PORT: new URL(ssoServerUrl).port, HQ_APP_ORIGIN: ssoViteUrl },
        `${ssoServerUrl}/health`,
      ),
    ),
    webBuild.then(() =>
      startDetached(
        ['bunx', 'vite', 'preview', ...e2eBuild, '--port', new URL(ssoViteUrl).port],
        `${repositoryRoot}apps/web`,
        { HQ_SERVER_URL: ssoServerUrl },
        ssoViteUrl,
      ),
    ),
  ])
  const toolServers = await fetch(`${serverUrl}/test/tool-servers`, { method: 'POST' })
  if (!toolServers.ok) throw new Error(`Setting up the test tool servers failed with ${toolServers.status}`)
  return async () => {
    stopVite()
    stopServer()
    stopSsoVite()
    stopSsoServer()
    removeWorkerHosts()
  }
}
