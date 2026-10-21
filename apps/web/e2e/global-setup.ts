import { execFile, execSync, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createDatabase } from '@spyria/db/postgres'
import {
  buildTemplateDatabase,
  databaseUrlOf,
  dropDatabase,
  httpStatusOf,
  startTestDex,
  startTestGateway,
  startTestPostgres,
  testGatewayAdmin,
} from '@spyria/db/testing'
import {
  fakeMcpUrl,
  gatewayPort,
  gatewayUrl,
  maximumWorkerCount,
  serverUrl,
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
    select datname as name from pg_database where datname like 'spyria\\_e2e\\_w%'`
  await admin.end()
  for (const { name } of leftoverDatabases) await dropDatabase(name)
  removeWorkerHosts()
}

const removeWorkerHosts = () => {
  execSync(`pkill -f '${repositoryRoot}apps/host/src/main.ts ${serverUrl}/h/' || true`)
}

const startDetached = async (command: string[], cwd: string, env: Record<string, string>, readyUrl: string) => {
  const [executable = '', ...args] = command
  const logFile = openSync(join(tmpdir(), `spyria-e2e-${new URL(readyUrl).port}.log`), 'w')
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', logFile, logFile],
  })
  for (let attempt = 1; typeof (await httpStatusOf(readyUrl)) !== 'number'; attempt++) {
    if (attempt === 400) throw new Error(`${command.join(' ')} did not start`)
    await sleep(50)
  }
  return () => process.kill(-(child.pid ?? 0), 'SIGTERM')
}

export default async function globalSetup() {
  await startTestPostgres()
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
        SPYRIA_APP_ORIGIN: viteUrl,
        SPYRIA_GATEWAY_URL: gatewayUrl,
        SPYRIA_GATEWAY_ADMIN_USER: testGatewayAdmin.user,
        SPYRIA_GATEWAY_ADMIN_PASSWORD: testGatewayAdmin.password,
        SPYRIA_FAKE_MCP_PORT: new URL(fakeMcpUrl).port,
      },
      `${serverUrl}/health`,
    ),
    webBuild.then(() =>
      startDetached(
        ['bunx', 'vite', 'preview', ...e2eBuild, '--port', new URL(viteUrl).port],
        `${repositoryRoot}apps/web`,
        { SPYRIA_SERVER_URL: serverUrl },
        viteUrl,
      ),
    ),
    startTestDex().then(() =>
      startDetached(
        ['bun', 'src/testing/sso-test-server.ts'],
        `${repositoryRoot}apps/server`,
        { PORT: new URL(ssoServerUrl).port, SPYRIA_APP_ORIGIN: ssoViteUrl },
        `${ssoServerUrl}/health`,
      ),
    ),
    webBuild.then(() =>
      startDetached(
        ['bunx', 'vite', 'preview', ...e2eBuild, '--port', new URL(ssoViteUrl).port],
        `${repositoryRoot}apps/web`,
        { SPYRIA_SERVER_URL: ssoServerUrl },
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
