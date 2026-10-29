import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { get } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { gatewayKeyRefOf } from '@spyria/kernel'
import { type SQL, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createDatabase } from './client.ts'
import { resetDatabase } from './seed.ts'

const templateDatabaseName = 'spyria_test_template'
export const databaseDropTimeoutMilliseconds = 30_000
const testPostgresContainer = 'spyria-test-postgres'
const testPostgresUrl = 'postgres://spyria:spyria-test@localhost:5435/postgres'
const docker = (...args: string[]) => spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })

export const databaseUrlOf = (databaseName: string) =>
  Object.assign(new URL(testPostgresUrl), { pathname: `/${databaseName}` }).href

const adminRows = async <Row>(statement: string, parameters: string[] = []) => {
  const admin = postgres(databaseUrlOf('postgres'), { onnotice: () => {} })
  try {
    return [...(await admin.unsafe<Row[]>(statement, parameters))]
  } finally {
    await admin.end()
  }
}
const withAdmin = async (statement: string, parameters: string[] = []) => {
  await adminRows(statement, parameters)
}
const databaseOidOf = async (name: string) =>
  (await adminRows<{ oid: string }>('select oid::text as oid from pg_database where datname = $1', [name]))[0]?.oid

const releaseReplicationSlotsOf = async (name: string) => {
  await withAdmin(
    'select pg_terminate_backend(active_pid) from pg_replication_slots where database = $1 and active_pid is not null',
    [name],
  )
  await withAdmin(
    'select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = $1 and not active',
    [name],
  )
}

export const dropDatabase = async (name: string) => {
  for (let attempt = 1; ; attempt++)
    try {
      await releaseReplicationSlotsOf(name)
      return await withAdmin(`drop database if exists "${name}" with (force)`)
    } catch (error) {
      if (attempt === 200) throw error
      await sleep(50)
    }
}

export const migrateDatabase = (database: ReturnType<typeof createDatabase>) =>
  migrate(database, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })

export const createTestDatabase = async (
  template = templateDatabaseName,
  name = `spyria_test_${crypto.randomUUID().replaceAll('-', '')}`,
) => {
  await withAdmin(`create database "${name}" template "${template}"`)
  const createdOid = await databaseOidOf(name)
  const database = createDatabase(databaseUrlOf(name))
  return {
    name,
    database,
    drop: async () => {
      await database.$client.end({ timeout: 5 })
      if ((await databaseOidOf(name)) === createdOid) await dropDatabase(name)
    },
  }
}

const leftoverTestDatabaseName = /^(spyria_test_[0-9a-f]{32}|spyria_e2e_w[0-9]+)$/
const leftoverTestSlotName = /^(spyriatest|spyriae2e)[0-9]*_/
const leftoverTestDockerName = /^spyria-test-(([0-9a-f]{8}|other-[0-9a-f]{8}|e2e)-|certs-[0-9a-f]{8}$)/
const leftoverDockerAgeMilliseconds = 30 * 60_000

export const isLeftoverTestDockerObject = (name: string, createdAt: string, now = Date.now()) =>
  leftoverTestDockerName.test(name) && now - new Date(createdAt).getTime() > leftoverDockerAgeMilliseconds

const dockerLines = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .split('\n')
    .filter(Boolean)
const leftoverDockerKinds = [
  { kind: 'container', all: ['-a'], name: '{{.Names}}', createdAt: '{{.Created}}', force: ['-fv'] },
  { kind: 'volume', all: [], name: '{{.Name}}', createdAt: '{{.CreatedAt}}', force: [] },
  { kind: 'network', all: [], name: '{{.Name}}', createdAt: '{{.Created}}', force: [] },
]

const removeLeftoverTestDockerObjects = () => {
  for (const { kind, all, name, createdAt, force } of leftoverDockerKinds) {
    const names = dockerLines(kind, 'ls', ...all, '--format', name).filter((each) => leftoverTestDockerName.test(each))
    if (names.length === 0) continue
    const createdAts = dockerLines(kind, 'inspect', '--format', createdAt, ...names)
    const leftovers = names.filter((each, index) => isLeftoverTestDockerObject(each, createdAts[index] ?? ''))
    if (leftovers.length > 0) docker(kind, 'rm', ...force, ...leftovers)
  }
}

export const removeLeftoversOfKilledRuns = async () => {
  removeLeftoverTestDockerObjects()
  const admin = postgres(databaseUrlOf('postgres'), { onnotice: () => {} })
  try {
    await admin`select pg_drop_replication_slot(slot_name) from pg_replication_slots
      where not active and slot_name ~ ${leftoverTestSlotName.source}`
    const stale = await admin<{ datname: string }[]>`select datname from pg_database
      where datname ~ ${leftoverTestDatabaseName.source}
        and datname not in (select datname from pg_stat_activity where datname is not null)`
    for (const { datname } of stale) await admin.unsafe(`drop database if exists "${datname}"`)
  } finally {
    await admin.end()
  }
}

export const buildTemplateDatabase = async (name = templateDatabaseName) => {
  await removeLeftoversOfKilledRuns()
  await dropDatabase(name)
  await withAdmin(`create database "${name}"`)
  const database = createDatabase(databaseUrlOf(name))
  await migrateDatabase(database)
  await resetDatabase(database)
  await database.$client.end()
}

export const httpStatusOf = (url: string, headers: Record<string, string> = {}) =>
  new Promise<number | string>((resolve) => {
    get(url, { headers }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    }).on('error', (error) => resolve(String(error)))
  })

const zeroPackage = new URL('../../node_modules/@rocicorp/zero/', import.meta.url).pathname
const zeroCacheCli = `${zeroPackage}out/zero/src/cli.js`
const zeroPackageDirectories = [zeroPackage, `${realpathSync(zeroPackage)}/`]

const gracefulStopMilliseconds = 5000

const signalGroup = (group: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-group, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

const stopProcessGroup = async (process: ChildProcess) => {
  const group = process.pid ?? 0
  if (process.exitCode === null && process.signalCode === null) {
    const exited = once(process, 'exit')
    signalGroup(group, 'SIGTERM')
    await Promise.race([exited, sleep(gracefulStopMilliseconds)])
  }
  signalGroup(group, 'SIGKILL')
}

const outputOf = (command: string, args: string[]) => String(spawnSync(command, args).stdout ?? '')

const isZeroCacheCommand = (command: string) => zeroPackageDirectories.some((directory) => command.includes(directory))

export type ProcessRow = { pid: number; parent: number; group: number; command: string }

export const processTable = (): ProcessRow[] =>
  outputOf('ps', ['-eo', 'pid=,ppid=,pgid=,args='])
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 4)
    .map(([pid = '', parent = '', group = '', ...command]) => ({
      pid: Number(pid),
      parent: Number(parent),
      group: Number(group),
      command: command.join(' '),
    }))

export const describeProcesses = (rows: readonly ProcessRow[]) =>
  rows.map(({ pid, parent, group, command }) => `${pid} (parent ${parent}, group ${group}): ${command.slice(0, 200)}`)

export const noteTestStack = (line: string) => process.stderr.write(`[test stack] ${line}\n`)

const lsofPortsPerCall = 50
const isLsofWarning = (line: string) => line === '' || /^lsof: WARNING/.test(line)

export const listenersOn = (ports: readonly (number | string)[]): ProcessRow[] => {
  const listenerIds = new Set<number>()
  for (let start = 0; start < ports.length; start += lsofPortsPerCall) {
    const batch = ports.slice(start, start + lsofPortsPerCall)
    const lookup = spawnSync('lsof', ['-t', `-iTCP:${batch.join(',')}`, '-sTCP:LISTEN'])
    const failure =
      lookup.error?.message ??
      String(lookup.stderr ?? '')
        .split('\n')
        .find((line) => !isLsofWarning(line.trim()))
    if (failure) {
      noteTestStack(
        `lsof could not list the listeners on ports ${batch.join(',')}, so no listener is stopped: ${failure}`,
      )
      return []
    }
    for (const line of String(lookup.stdout ?? '').split('\n')) if (line.trim()) listenerIds.add(Number(line))
  }
  const table = processTable()
  return [...listenerIds].map(
    (pid) => table.find((row) => row.pid === pid) ?? { pid, parent: 0, group: 0, command: '(exited)' },
  )
}

const isListeningAt = (port: number | string, host: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port: Number(port), host })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })

export const busyPortsOf = async (ports: readonly (number | string)[]) => {
  const answers = await Promise.all(
    ports.map(async (port) => (await isListeningAt(port, '127.0.0.1')) || isListeningAt(port, '::1')),
  )
  return ports.filter((_, index) => answers[index])
}

const leftoverZeroCacheGroupsOn = (ports: number[]) => {
  const listeningGroups = new Set(listenersOn(ports).map(({ group }) => group))
  const table = processTable()
  return [...listeningGroups].filter(
    (group) => group > 1 && table.filter((row) => row.group === group).every((row) => isZeroCacheCommand(row.command)),
  )
}

const freeZeroCachePorts = async (ports: number[]) => {
  const table = processTable()
  for (const group of new Set(leftoverZeroCacheGroupsOn(ports))) {
    const members = describeProcesses(table.filter((row) => row.group === group))
    noteTestStack(`SIGKILL to the leftover zero-cache group ${group}: ${members.join('; ')}`)
    signalGroup(group, 'SIGKILL')
  }
  for (let attempt = 1; ; attempt++) {
    const busyPorts = await busyPortsOf(ports)
    if (busyPorts.length === 0) return
    if (attempt === 100)
      throw new Error(
        `zero-cache cannot start: port ${busyPorts.join(', ')} is still in use after stopping leftover zero-caches`,
      )
    await sleep(50)
  }
}

export const stopLeftoverZeroCache = (port: number) => freeZeroCachePorts([port, port + 1])
export const stopLeftoverZeroCaches = (ports: number[]) => freeZeroCachePorts(ports)

export const startZeroCache = async ({
  databaseName,
  port,
  appId,
  serverUrl,
  logLevel = process.env.SPYRIA_ZERO_LOG_LEVEL ?? 'error',
}: {
  databaseName: string
  port: number
  appId: string
  serverUrl: string
  logLevel?: string
}) => {
  const url = `http://localhost:${port}`
  await freeZeroCachePorts([port, port + 1])
  const replicaFile = join(tmpdir(), `spyria-zero-${appId}.db`)
  for (const suffix of ['', '-wal', '-shm', '-wal2']) rmSync(`${replicaFile}${suffix}`, { force: true })
  const logPath = join(tmpdir(), `spyria-zero-${appId}.log`)
  const logFile = openSync(logPath, 'w')
  const zeroCache = spawn('node', [zeroCacheCli], {
    detached: true,
    stdio: ['ignore', logFile, 'pipe'],
    env: {
      ...process.env,
      ZERO_UPSTREAM_DB: databaseUrlOf(databaseName),
      ZERO_QUERY_URL: `${serverUrl}/api/query`,
      ZERO_MUTATE_URL: `${serverUrl}/api/mutate`,
      ZERO_PORT: String(port),
      ZERO_CHANGE_STREAMER_PORT: String(port + 1),
      ZERO_REPLICA_FILE: replicaFile,
      ZERO_APP_ID: appId,
      ZERO_TASK_ID: `spyria-${appId}`,
      ZERO_APP_PUBLICATIONS: 'spyria_zero',
      ZERO_ADMIN_PASSWORD: 'spyria-test',
      ZERO_NUM_SYNC_WORKERS: '1',
      ZERO_UPSTREAM_MAX_CONNS: '4',
      ZERO_CVR_MAX_CONNS: '4',
      ZERO_LOG_LEVEL: logLevel,
      ZERO_ENABLE_TELEMETRY: 'false',
    },
  })
  const stopGroupOnExit = () => zeroCache.exitCode === null && process.kill(-(zeroCache.pid ?? 0), 'SIGKILL')
  process.once('exit', stopGroupOnExit)
  const stop = () => {
    process.off('exit', stopGroupOnExit)
    return stopProcessGroup(zeroCache)
  }
  let errorOutput = ''
  zeroCache.stderr?.on('data', (chunk) => {
    writeSync(logFile, chunk)
    errorOutput = `${errorOutput}${chunk}`.slice(-4000)
  })
  const exited = once(zeroCache, 'exit').then(() => `zero-cache on port ${port} exited: ${errorOutput}`)
  for (let attempt = 1; (await httpStatusOf(`${url}/keepalive`)) !== 200; attempt++) {
    if (zeroCache.exitCode !== null || attempt === 600) {
      await stop()
      throw new Error(`zero-cache on port ${port} did not start: ${errorOutput}`)
    }
    await sleep(50)
  }
  return { url, exited, stop, logPath }
}

const gatewayImage = 'maximhq/bifrost:v2.3.2@sha256:f5b18826349fe9e1c402c10d19f1cbb5567a3c800ad928580d07f72e69106ec7'
export const testGatewayAdmin = { user: 'spyria-test', password: 'spyria-test-gateway-password' }
const gatewayProviders = ['openai', 'anthropic', 'mistral', 'typesafe', 'openrouter', 'gemini', 'xai']
const zaiPaths = {
  chat_completion: '/chat/completions',
  chat_completion_stream: '/chat/completions',
  list_models: '/models',
}
const testModelPrices = {
  'claude-opus-5-5': 0.000005,
  'claude-sonnet-5-5': 0.000003,
  'claude-haiku-5-5': 0.000001,
  'mistral-large-latest': 0.00003,
  'mistral-medium-latest': 0.000015,
  'mistral-small-latest': 0.000006,
  'codestral-latest': 0.000009,
  'grok-4.7': 0.000004,
  'grok-4.3': 0.000002,
  'grok-code-fast': 0.0000005,
  'gemini-pro-latest': 0.000004,
  'gemini-flash-latest': 0.000002,
  'gemini-flash-lite-latest': 0.0000005,
  'anthropic/claude-opus-5.5': 0.000004,
  'anthropic/claude-sonnet-5.5': 0.000002,
  'anthropic/claude-haiku-5.5': 0.0000005,
}

const gatewayAuthorization = `Basic ${btoa(`${testGatewayAdmin.user}:${testGatewayAdmin.password}`)}`

export const testGatewayAt = (url: string) => {
  const request = (path: string, init: { method?: string; body?: object } = {}) =>
    fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: gatewayAuthorization, 'content-type': 'application/json' },
      body: init.body && JSON.stringify(init.body),
    })
  const call = async <Result>(path: string, init: { method?: string; body?: object } = {}) => {
    const response = await request(path, init)
    if (!response.ok)
      throw new Error(
        `The test gateway answered ${init.method ?? 'GET'} ${path} with ${response.status}: ${(await response.text()).slice(0, 200)}`,
      )
    return (await response.json()) as Result
  }
  return { url, request, call }
}
type TestGateway = ReturnType<typeof testGatewayAt>

export const testDexIssuer = 'http://localhost:5557/dex'
const testDexConfig = new URL('../../../../apps/web/e2e/dex-test.yaml', import.meta.url).pathname

const startTestContainer = async (name: string, runArguments: string[], isReady: () => Promise<boolean>) => {
  const setupHash = createHash('sha256').update(JSON.stringify(runArguments)).digest('hex').slice(0, 16)
  const running = docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "spyria.setup"}}', name)
  if (running.stdout.toString().trim() === `true ${setupHash}` && (await isReady())) return
  docker('rm', '-fv', name)
  const started = docker('run', '-d', '--name', name, '--label', `spyria.setup=${setupHash}`, ...runArguments)
  if (started.status !== 0) throw new Error(`Starting ${name} failed: ${started.stderr}`)
  for (let attempt = 1; !(await isReady()); attempt++) {
    if (attempt === 400) throw new Error(`${name} did not start`)
    await sleep(50)
  }
}

export const startTestDex = () =>
  startTestContainer(
    'spyria-test-dex',
    [
      ...['--label', `spyria.config=${createHash('sha256').update(readFileSync(testDexConfig)).digest('hex')}`],
      ...['-p', `127.0.0.1:${new URL(testDexIssuer).port}:5556`, '-v', `${testDexConfig}:/etc/dex/config.yaml:ro`],
      ...['dexidp/dex:v2.43.1', 'dex', 'serve', '/etc/dex/config.yaml'],
    ],
    async () => (await httpStatusOf(`${testDexIssuer}/.well-known/openid-configuration`)) === 200,
  )

const isTestPostgresReady = async () => {
  const admin = postgres(testPostgresUrl, { onnotice: () => {}, connect_timeout: 1, max: 1 })
  try {
    await admin`select 1`
    return true
  } catch {
    return false
  } finally {
    await admin.end({ timeout: 1 })
  }
}

export const startTestPostgres = () =>
  startTestContainer(
    testPostgresContainer,
    [
      ...['-p', `${new URL(testPostgresUrl).port}:5432`, '--tmpfs', '/var/lib/postgresql:size=4g', '--shm-size', '1g'],
      ...['-e', 'POSTGRES_USER=spyria', '-e', `POSTGRES_PASSWORD=${new URL(testPostgresUrl).password}`, 'postgres:18'],
      ...['postgres', '-c', 'wal_level=logical', '-c', 'max_slot_wal_keep_size=1GB', '-c', 'max_wal_size=1GB'],
      ...['-c', 'max_connections=300', '-c', 'max_replication_slots=40', '-c', 'max_wal_senders=40'],
    ],
    isTestPostgresReady,
  )

export const startTestGateway = async ({
  name,
  port,
  fakeLlmUrl,
  oauthBase,
}: {
  name: string
  port: number
  fakeLlmUrl: string
  oauthBase: string
}) => {
  const containerName = `spyria-test-gateway-${name}`
  const databaseName = `spyria_test_gateway_${name}`
  const configFile = join(tmpdir(), `${containerName}.json`)
  const gatewayConfig = JSON.parse(readFileSync(new URL('../../../../infra/bifrost.json', import.meta.url), 'utf8'))
  const clientConfig = { ...gatewayConfig.client, mcp_oauth_private_allowlist: ['host.docker.internal'] }
  const networkConfig = {
    base_url: fakeLlmUrl,
    default_request_timeout_in_seconds: 60,
    max_retries: 0,
    allow_private_network: true,
  }
  const setup = {
    testPostgresStartedAt: docker('inspect', '-f', '{{.State.StartedAt}}', testPostgresContainer).stdout.toString(),
    gatewayImage,
    port,
    networkConfig,
    oauthBase,
    gatewayConfig,
    clientConfig,
    gatewayProviders,
    zaiPaths,
    testModelPrices,
  }
  const setupHash = createHash('sha256').update(JSON.stringify(setup)).digest('hex').slice(0, 16)
  const gateway = testGatewayAt(`http://127.0.0.1:${port}`)
  let lastAnswer: number | string = 'nothing'
  const isReady = async () => {
    lastAnswer = await httpStatusOf(`${gateway.url}/api/providers`, { authorization: gatewayAuthorization })
    return lastAnswer === 200
  }
  const isSetUp = async () => {
    const overrides = await gateway.request('/api/governance/pricing-overrides')
    const names = JSON.stringify(overrides.ok ? await overrides.json() : {})
    return Object.keys(testModelPrices).every((model) => names.includes(`"${model}"`))
  }
  const running = docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "spyria.setup"}}', containerName)
  if (running.stdout.toString().trim() === `true ${setupHash}` && (await isReady()) && (await isSetUp())) {
    const { clients } = await gateway.call<{ clients: { config: { client_id: string } }[] | null }>('/api/mcp/clients')
    for (const { config } of clients ?? [])
      await gateway.call(`/api/mcp/client/${config.client_id}`, { method: 'DELETE' })
    return gateway
  }
  const postgresUrl = new URL(testPostgresUrl)
  const store = {
    enabled: true,
    type: 'postgres',
    config: {
      host: 'host.docker.internal',
      port: postgresUrl.port,
      user: postgresUrl.username,
      password: postgresUrl.password,
      db_name: databaseName,
      ssl_mode: 'disable',
    },
  }
  docker('rm', '-fv', containerName)
  await dropDatabase(databaseName)
  await withAdmin(`create database "${databaseName}" template template0 encoding 'UTF8'`)
  writeFileSync(
    configFile,
    JSON.stringify({ ...gatewayConfig, client: clientConfig, config_store: store, logs_store: store }),
  )
  const remove = async () => {
    docker('rm', '-fv', containerName)
    rmSync(configFile, { force: true })
    await dropDatabase(databaseName)
  }
  const started = docker(
    'run',
    '-d',
    '--name',
    containerName,
    '--label',
    `spyria.setup=${setupHash}`,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-p',
    `127.0.0.1:${port}:8080`,
    '-v',
    `${configFile}:/app/data/config.json:ro`,
    '-e',
    'BIFROST_ENCRYPTION_KEY=spyria-test-gateway-encryption-key',
    '-e',
    'BIFROST_SETUP_TOKEN=spyria-test-gateway-setup-token',
    '-e',
    `BIFROST_ADMIN_USER=${testGatewayAdmin.user}`,
    '-e',
    `BIFROST_ADMIN_PASSWORD=${testGatewayAdmin.password}`,
    '-e',
    `SPYRIA_GATEWAY_OAUTH_BASE=${oauthBase}`,
    gatewayImage,
  )
  if (started.status !== 0) {
    await remove()
    throw new Error(`The test gateway did not start: ${started.stderr.toString()}`)
  }
  try {
    for (let attempt = 1; !(await isReady()); attempt++) {
      if (attempt === 480) throw new Error(`The test gateway did not become ready (last answer: ${lastAnswer})`)
      await sleep(250)
    }
    for (const provider of gatewayProviders)
      await gateway.call('/api/providers', {
        method: 'POST',
        body: { provider, keys: [], network_config: networkConfig },
      })
    await gateway.call('/api/providers', {
      method: 'POST',
      body: { provider: 'deepseek', keys: [], network_config: { ...networkConfig, base_url: `${fakeLlmUrl}/v1` } },
    })
    await gateway.call('/api/providers', {
      method: 'POST',
      body: {
        provider: 'zai',
        keys: [],
        network_config: { ...networkConfig, base_url: `${fakeLlmUrl}/v1` },
        custom_provider_config: { base_provider_type: 'openai', request_path_overrides: zaiPaths },
      },
    })
    for (const [model, dollarsPerToken] of Object.entries(testModelPrices))
      await gateway.call('/api/governance/pricing-overrides', {
        method: 'POST',
        body: {
          name: model,
          scope_kind: 'global',
          match_type: 'exact',
          pattern: model,
          request_types: ['chat_completion'],
          patch: { input_cost_per_token: dollarsPerToken, output_cost_per_token: dollarsPerToken },
        },
      })
  } catch (error) {
    await remove()
    throw error
  }
  return gateway
}

const aliceSeededCredential = {
  workspaceId: 'workspace-acme',
  id: 'credential-alice-anthropic',
  userId: 'member-alice',
}
type SeedWriter = { execute: (query: SQL) => Promise<unknown> }

export const testCrmConnection = { id: 'connection-crm', name: 'CRM', gatewayName: 'crm' }
export const shareTestCrm = (writer: SeedWriter) =>
  writer.execute(
    sql`insert into workspace_connections (workspace_id, id, name, gateway_name, url, header_name, tools, allowed_tools)
      values (${aliceSeededCredential.workspaceId}, ${testCrmConnection.id}, ${testCrmConnection.name},
        ${testCrmConnection.gatewayName}, 'http://fake-mcp/shared/mcp', null,
        '[{"name":"lookup","readOnly":true},{"name":"update","readOnly":false}]', '["lookup","update"]')`,
  )

type SeededGatewayKeys = ((writer: SeedWriter) => Promise<void>) & { keyId: string; virtualKeyId: string }
const isUntouched = async (gateway: TestGateway, { keyId, virtualKeyId }: SeededGatewayKeys) => {
  const read = await gateway.request(`/api/governance/virtual-keys/${virtualKeyId}`)
  if (!read.ok) return false
  const { virtual_key } = (await read.json()) as {
    virtual_key: { is_active: boolean; provider_configs: { keys: { key_id: string }[] }[]; mcp_configs?: unknown[] }
  }
  const keyIds = virtual_key.provider_configs.flatMap((config) => config.keys.map((key) => key.key_id))
  return (
    virtual_key.is_active && keyIds.length === 1 && keyIds[0] === keyId && (virtual_key.mcp_configs ?? []).length === 0
  )
}

export const prepareSeededGatewayKeys = async (
  gateway: TestGateway,
  previous?: SeededGatewayKeys,
): Promise<SeededGatewayKeys> => {
  if (previous && (await isUntouched(gateway, previous))) return previous
  const { id: keyId } = await gateway.call<{ id: string }>('/api/providers/mistral/keys', {
    method: 'POST',
    body: {
      name: `cred_${crypto.randomUUID()}`,
      value: `fake-key-seeded-${crypto.randomUUID()}`,
      models: ['*'],
      weight: 1,
    },
  })
  const { virtual_key } = await gateway.call<{ virtual_key: { id: string } }>('/api/governance/virtual-keys', {
    method: 'POST',
    body: {
      name: `vk_${crypto.randomUUID()}`,
      is_active: true,
      provider_configs: [{ provider: 'mistral', weight: 1, allowed_models: ['*'], key_ids: [keyId] }],
    },
  })
  const { workspaceId, id, userId } = aliceSeededCredential
  const write = async (writer: SeedWriter) => {
    await writer.execute(
      sql`update llm_credentials set secret_ref = ${gatewayKeyRefOf({ provider: 'mistral', id: keyId })} where workspace_id = ${workspaceId} and id = ${id}`,
    )
    await writer.execute(
      sql`insert into member_gateway_keys (workspace_id, user_id, virtual_key_id) values (${workspaceId}, ${userId}, ${virtual_key.id})`,
    )
  }
  return Object.assign(write, { keyId, virtualKeyId: virtual_key.id })
}

const monthDayOf = (now: Date, monthsBack: number, day: number, hour = 12) =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, day, hour)).toISOString()

export const seedModelCall = (writer: SeedWriter, prompterId: string, costMicros: number, calledAt = new Date()) =>
  writer.execute(sql`with call as (
      insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider, input_tokens,
        output_tokens, cost_micros, status, called_at)
      values ('workspace-acme', ${`call-${crypto.randomUUID()}`}, 'chat-research', ${prompterId}, null,
        'codestral-latest', 'mistral', 1, 1, ${costMicros}, 'success', ${calledAt.toISOString()}::timestamptz)
      returning *)
    insert into usage_entries (workspace_id, month, chat_id, user_id, model, tokens, cost_micros, calls)
    select workspace_id, to_char(called_at at time zone 'UTC', 'YYYY-MM'), chat_id, prompter_id, provider || '/' || model,
      input_tokens + output_tokens, cost_micros, 1
    from call
    on conflict (workspace_id, month, chat_id, user_id, model) do update set
      tokens = usage_entries.tokens + excluded.tokens,
      cost_micros = usage_entries.cost_micros + excluded.cost_micros,
      calls = usage_entries.calls + excluded.calls`)

export const seedSpend = async (writer: SeedWriter, now = new Date()) => {
  const calls = [1, 0].flatMap((monthsBack) => {
    const scale = monthsBack === 0 ? 2 : 1
    const month = monthsBack === 0 ? 'this' : 'last'
    const call = (prompter: string, chat: string, provider: string, model: string, turn: string, day: number) => ({
      workspace: 'workspace-acme',
      id: `call-${crypto.randomUUID()}`,
      chat,
      prompter,
      provider,
      model,
      input: 400 * scale,
      output: 100 * scale,
      cost: 5000 * scale,
      role: model === 'gpt-5-mini' ? 'delegate' : null,
      turn: `turn-${turn}-${month}`,
      session: `session-${prompter}-${month}`,
      at: monthDayOf(now, monthsBack, day),
    })
    return [
      call('member-alice', 'chat-invoice-bug', 'anthropic', 'claude-sonnet', 'alice-1', 2),
      call('member-alice', 'chat-invoice-bug', 'openai', 'gpt-5-mini', 'alice-1', 2),
      call('member-alice', 'chat-invoice-bug', 'anthropic', 'claude-sonnet', 'alice-2', 3),
      call('member-alice', 'chat-invoice-bug', 'anthropic', 'claude-sonnet', 'alice-2', 3),
      call('member-bob', 'chat-research', 'openai', 'gpt-5', 'bob', 2),
      call('member-bob', 'chat-research', 'openai', 'gpt-5', 'bob', 2),
      call('member-lee', 'chat-setup-helper', 'openai', 'gpt-5', 'lee', 3),
      call('member-lee', 'chat-setup-helper', 'openai', 'gpt-5', 'lee', 3),
    ]
  })
  const globexCall = {
    ...calls[0],
    workspace: 'workspace-globex',
    id: 'call-globex',
    chat: 'chat-launch-plan',
    cost: 999_000,
  }
  await writer.execute(sql`insert into model_calls (workspace_id, id, chat_id, prompter_id, owner_id, model, provider,
      input_tokens, output_tokens, cost_micros, status, role, turn_id, session_id, called_at)
    select workspace, id, chat, prompter, null, model, provider, input, output, cost, 'success', role, turn, session, at
    from jsonb_to_recordset(${JSON.stringify([...calls, globexCall])}::jsonb) as call(workspace text, id text, chat text,
      prompter text, provider text, model text, input int, output int, cost int, role text, turn text, session text,
      at timestamptz)`)
  const step = (state: string) =>
    JSON.stringify({
      type: 'pull_request',
      repository: 'acme/app',
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      title: 'Fix the invoice total',
      state,
    })
  for (const [id, type, payload, at] of [
    [
      'spend-pull-request',
      'message.posted',
      `{"kind":"step","body":"pull_request","replyToId":null,"step":${step('open')}}`,
      monthDayOf(now, 0, 2, 13),
    ],
    [
      'spend-pull-request-merged',
      'message.step_changed',
      `{"messageId":"spend-pull-request","step":${step('merged')}}`,
      monthDayOf(now, 0, 3, 13),
    ],
  ])
    await writer.execute(sql`insert into events (workspace_id, chat_id, id, seq, type, actor, payload, created_at)
      select 'workspace-acme', 'chat-invoice-bug', ${id}, coalesce(max(seq), 0) + 1, ${type}, 'member-alice',
        ${payload}::jsonb, ${at}::timestamptz
      from events where workspace_id = 'workspace-acme' and chat_id = 'chat-invoice-bug'`)
}
