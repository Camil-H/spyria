import { execSync, spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDatabase } from '@hq/db/postgres'
import { buildTemplateDatabase, databaseUrlOf, dropDatabase } from '@hq/db/testing'
import { maximumWorkerCount, serverUrl, templateDatabaseName, viteUrl, zeroCachePortOf } from './stack-ports.ts'

const repositoryRoot = new URL('../../../', import.meta.url).pathname

const listenersOn = (port: number) =>
  execSync(`lsof -ti tcp:${port} -sTCP:LISTEN || true`).toString().split('\n').filter(Boolean)

const stopListenersOn = async (port: number) => {
  for (const processId of listenersOn(port))
    process.kill(-Number(execSync(`ps -o pgid= -p ${processId}`).toString().trim()), 'SIGTERM')
  for (let attempt = 1; listenersOn(port).length > 0; attempt++) {
    if (attempt === 100) throw new Error(`Port ${port} is still in use`)
    await sleep(100)
  }
}

const sweepLeftovers = async () => {
  for (const port of [
    new URL(serverUrl).port,
    new URL(viteUrl).port,
    ...Array.from({ length: maximumWorkerCount }, (_, index) => [zeroCachePortOf(index), zeroCachePortOf(index) + 1]),
  ].flat())
    await stopListenersOn(Number(port))
  const admin = createDatabase(databaseUrlOf('postgres')).$client
  const leftoverDatabases = await admin<{ name: string }[]>`
    select datname as name from pg_database where datname like 'hq\\_e2e\\_w%'`
  await admin.end()
  for (const { name } of leftoverDatabases) await dropDatabase(name)
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
  for (
    let attempt = 1;
    !(await fetch(readyUrl).then(
      (response) => response.ok,
      () => false,
    ));
    attempt++
  ) {
    if (attempt === 400) throw new Error(`${command.join(' ')} did not start`)
    await sleep(50)
  }
  return () => process.kill(-(child.pid ?? 0), 'SIGTERM')
}

export default async function globalSetup() {
  execSync('docker compose -f infra/docker-compose.yml up -d --wait postgres dex', {
    cwd: repositoryRoot,
    stdio: 'ignore',
  })
  await sweepLeftovers()
  await buildTemplateDatabase(templateDatabaseName)
  const stopServer = await startDetached(
    ['bun', 'src/test-server.ts'],
    `${repositoryRoot}apps/server`,
    { PORT: new URL(serverUrl).port, HQ_APP_ORIGIN: viteUrl },
    `${serverUrl}/health`,
  )
  const stopVite = await startDetached(
    ['bun', 'run', 'dev', '--port', new URL(viteUrl).port],
    `${repositoryRoot}apps/web`,
    { HQ_SERVER_URL: serverUrl, HQ_VITE_CACHE_DIR: 'node_modules/.vite-e2e' },
    viteUrl,
  )
  return () => {
    stopVite()
    stopServer()
  }
}
