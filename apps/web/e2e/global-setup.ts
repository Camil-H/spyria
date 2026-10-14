import { execSync, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
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
  templateDatabaseName,
  viteUrl,
  zeroCachePortOf,
} from './stack-ports.ts'

const repositoryRoot = new URL('../../../', import.meta.url).pathname

const sweptPorts = [
  new URL(serverUrl).port,
  new URL(viteUrl).port,
  new URL(fakeMcpUrl).port,
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

export default async function globalSetup() {
  execSync('docker compose -f infra/docker-compose.yml up -d --wait --no-recreate postgres dex', {
    cwd: repositoryRoot,
    stdio: 'ignore',
  })
  await sweepLeftovers()
  const [, , stopServer, stopVite] = await Promise.all([
    buildTemplateDatabase(templateDatabaseName),
    startTestGateway({
      name: 'e2e',
      port: gatewayPort,
      fakeLlmUrl: `http://host.docker.internal:${new URL(serverUrl).port}/fake-llm`,
      oauthBase: `${viteUrl}/gateway-oauth`,
    }),
    startDetached(
      ['bun', 'src/test-server.ts'],
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
    startDetached(
      ['bun', 'run', 'dev', '--port', new URL(viteUrl).port],
      `${repositoryRoot}apps/web`,
      { HQ_SERVER_URL: serverUrl, HQ_VITE_CACHE_DIR: 'node_modules/.vite-e2e' },
      viteUrl,
    ),
  ])
  const toolServers = await fetch(`${serverUrl}/test/tool-servers`, { method: 'POST' })
  if (!toolServers.ok) throw new Error(`Setting up the test tool servers failed with ${toolServers.status}`)
  return async () => {
    stopVite()
    stopServer()
    removeWorkerHosts()
  }
}
