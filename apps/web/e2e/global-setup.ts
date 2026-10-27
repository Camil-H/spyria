import { execFile, spawn } from 'node:child_process'
import { openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createDatabase } from '@spyria/db/postgres'
import {
  buildTemplateDatabase,
  busyPortsOf,
  databaseUrlOf,
  describeProcesses,
  dropDatabase,
  httpStatusOf,
  listenersOn,
  noteTestStack,
  type ProcessRow,
  processTable,
  startTestDex,
  startTestGateway,
  startTestPostgres,
  stopLeftoverZeroCaches,
  testGatewayAdmin,
} from '@spyria/db/testing'
import {
  fakeMcpUrl,
  gatewayPort,
  gatewayUrl,
  serverUrl,
  ssoServerUrl,
  ssoViteUrl,
  templateDatabaseName,
  viteUrl,
  workerZeroCachePorts,
} from './stack-ports.ts'

const repositoryRoot = new URL('../../../', import.meta.url).pathname
const e2eBuild = ['--mode', 'e2e', '--outDir', 'node_modules/.e2e-dist']

const sweptPorts = [
  new URL(serverUrl).port,
  new URL(viteUrl).port,
  new URL(fakeMcpUrl).port,
  new URL(ssoServerUrl).port,
  new URL(ssoViteUrl).port,
  ...workerZeroCachePorts,
]
const terminate = (reason: string, targets: readonly ProcessRow[]) => {
  for (const target of targets) {
    noteTestStack(`SIGTERM to ${describeProcesses([target]).join('')}, ${reason}`)
    try {
      process.kill(target.pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
}

const stopWorkerZeroCaches = () => stopLeftoverZeroCaches(workerZeroCachePorts).catch(() => {})

const sweepLeftovers = async () => {
  await stopWorkerZeroCaches()
  terminate('a leftover listener on a test port', listenersOn(sweptPorts))
  for (let attempt = 1; ; attempt++) {
    const busyPorts = await busyPortsOf(sweptPorts)
    if (busyPorts.length === 0) break
    if (attempt === 100)
      throw new Error(
        `Ports ${busyPorts.join(', ')} are still in use after the sweep, held by: ${describeProcesses(listenersOn(busyPorts)).join('; ') || 'processes lsof could not list'}`,
      )
    await sleep(100)
  }
  const admin = createDatabase(databaseUrlOf('postgres')).$client
  const leftoverDatabases = await admin<{ name: string }[]>`
    select datname as name from pg_database where datname like 'spyria\\_e2e\\_w%'`
  await admin.end()
  for (const { name } of leftoverDatabases) await dropDatabase(name)
  removeWorkerHosts()
}

const removeWorkerHosts = () =>
  terminate(
    'a worker runtime host',
    processTable().filter(({ command }) => command.includes(`${repositoryRoot}apps/host/src/main.ts ${serverUrl}/h/`)),
  )

const startDetached = async (command: string[], cwd: string, env: Record<string, string>, readyUrl: string) => {
  const [executable = '', ...args] = command
  const port = new URL(readyUrl).port
  const holders = await busyPortsOf([port])
  if (holders.length > 0)
    throw new Error(
      `${command.join(' ')} cannot start: port ${port} is held by ${describeProcesses(listenersOn([port])).join('; ') || 'a process lsof could not list'}`,
    )
  const logPath = join(tmpdir(), `spyria-e2e-${port}.log`)
  const logFile = openSync(logPath, 'w')
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', logFile, logFile],
  })
  child.on('exit', (code, signal) =>
    writeSync(logFile, `\n${command.join(' ')} exited with ${signal ?? code} at ${new Date().toISOString()}\n`),
  )
  for (let attempt = 1; typeof (await httpStatusOf(readyUrl)) !== 'number'; attempt++) {
    if (attempt === 400) throw new Error(`${command.join(' ')} did not start`)
    await sleep(50)
  }
  const strangers = listenersOn([port]).filter(({ group }) => group > 0 && group !== child.pid)
  if (child.exitCode !== null || child.signalCode !== null || strangers.length > 0)
    throw new Error(
      `${command.join(' ')} exited with ${child.signalCode ?? child.exitCode ?? 'nothing yet'} while port ${port} answered from ${describeProcesses(strangers).join('; ') || 'another process'}: see ${logPath}`,
    )
  noteTestStack(`started ${command.join(' ')} as process group ${child.pid} on port ${port}`)
  return () => {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `${command.join(' ')} exited during the run with ${child.signalCode ?? child.exitCode}: see ${logPath}`,
      )
    const members = describeProcesses(processTable().filter(({ group }) => group === child.pid))
    noteTestStack(
      `SIGTERM to process group ${child.pid} (${command.join(' ')}) at the end of the run: ${members.join('; ')}`,
    )
    process.kill(-(child.pid ?? 0), 'SIGTERM')
  }
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
    const failures = [stopVite, stopServer, stopSsoVite, stopSsoServer].flatMap((stop) => {
      try {
        stop()
        return []
      } catch (error) {
        return [error]
      }
    })
    removeWorkerHosts()
    await stopWorkerZeroCaches()
    if (failures.length > 0) throw failures[0]
  }
}
