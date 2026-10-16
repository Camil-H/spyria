import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type SQL, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createDatabase, databaseUrl } from './client.ts'
import { resetDatabase } from './seed.ts'

const templateDatabaseName = 'hq_test_template'
export const databaseDropTimeoutMilliseconds = 30_000

export const databaseUrlOf = (databaseName: string) =>
  Object.assign(new URL(databaseUrl), { pathname: `/${databaseName}` }).href

const withAdmin = async (statement: string) => {
  const admin = postgres(databaseUrlOf('postgres'), { onnotice: () => {} })
  try {
    await admin.unsafe(statement)
  } finally {
    await admin.end()
  }
}

export const dropDatabase = async (name: string) => {
  for (let attempt = 1; ; attempt++)
    try {
      return await withAdmin(`drop database if exists "${name}" with (force)`)
    } catch (error) {
      if (attempt === 100) throw error
      await sleep(50)
    }
}

export const migrateDatabase = (database: ReturnType<typeof createDatabase>) =>
  migrate(database, { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname })

export const createTestDatabase = async (
  template = templateDatabaseName,
  name = `hq_test_${crypto.randomUUID().replaceAll('-', '')}`,
) => {
  await withAdmin(`create database "${name}" template "${template}"`)
  const database = createDatabase(databaseUrlOf(name))
  return {
    name,
    database,
    drop: async () => {
      await database.$client.end({ timeout: 5 })
      await dropDatabase(name)
    },
  }
}

const dropStaleTestObjects = async () => {
  const admin = postgres(databaseUrlOf('postgres'), { onnotice: () => {} })
  try {
    await admin`select pg_drop_replication_slot(slot_name) from pg_replication_slots
      where not active and slot_name ~ '^(hqtest|hqe2e)'`
    const stale = await admin<{ datname: string }[]>`select datname from pg_database
      where datname ~ '^(hq_test_[0-9a-f]{32}|hq_e2e_w[0-9]+)$'
        and datname not in (select datname from pg_stat_activity where datname is not null)`
    for (const { datname } of stale) await admin.unsafe(`drop database if exists "${datname}"`)
  } finally {
    await admin.end()
  }
}

export const buildTemplateDatabase = async (name = templateDatabaseName) => {
  await dropStaleTestObjects()
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

const zeroCacheCli = new URL('../../node_modules/@rocicorp/zero/out/zero/src/cli.js', import.meta.url).pathname

const gracefulStopMilliseconds = 5000

const stopProcessGroup = async (process: ChildProcess) => {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit').then(() => true)
  globalThis.process.kill(-(process.pid ?? 0), 'SIGTERM')
  if (await Promise.race([exited, sleep(gracefulStopMilliseconds, false)])) return
  globalThis.process.kill(process.pid ?? 0, 'SIGQUIT')
  await exited
}

export const startZeroCache = async ({
  databaseName,
  port,
  appId,
  serverUrl,
}: {
  databaseName: string
  port: number
  appId: string
  serverUrl: string
}) => {
  const url = `http://localhost:${port}`
  for (const busyPort of [port, port + 1])
    if (typeof (await httpStatusOf(`http://localhost:${busyPort}/`)) === 'number')
      throw new Error(`zero-cache cannot start: port ${busyPort} is in use (a leftover zero-cache? free it first)`)
  const replicaFile = join(tmpdir(), `hq-zero-${appId}.db`)
  for (const suffix of ['', '-wal', '-shm', '-wal2']) rmSync(`${replicaFile}${suffix}`, { force: true })
  const logFile = openSync(join(tmpdir(), `hq-zero-${appId}.log`), 'w')
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
      ZERO_APP_PUBLICATIONS: 'hq_zero',
      ZERO_ADMIN_PASSWORD: 'hq-test',
      ZERO_NUM_SYNC_WORKERS: '1',
      ZERO_UPSTREAM_MAX_CONNS: '4',
      ZERO_CVR_MAX_CONNS: '4',
      ZERO_LOG_LEVEL: process.env.HQ_ZERO_LOG_LEVEL ?? 'error',
      ZERO_ENABLE_TELEMETRY: 'false',
    },
  })
  let errorOutput = ''
  zeroCache.stderr?.on('data', (chunk) => {
    writeSync(logFile, chunk)
    errorOutput = `${errorOutput}${chunk}`.slice(-4000)
  })
  const exited = once(zeroCache, 'exit').then(() => `zero-cache on port ${port} exited: ${errorOutput}`)
  for (let attempt = 1; (await httpStatusOf(`${url}/keepalive`)) !== 200; attempt++) {
    if (zeroCache.exitCode !== null || attempt === 600) {
      await stopProcessGroup(zeroCache)
      throw new Error(`zero-cache on port ${port} did not start: ${errorOutput}`)
    }
    await sleep(50)
  }
  return { url, exited, stop: () => stopProcessGroup(zeroCache) }
}

const gatewayImage = 'maximhq/bifrost:v2.2.6@sha256:d0b4708ace1aa175766f94afa715fd9bba3a1b56c1dc2afff15a21edf3ae4e2a'
export const testGatewayAdmin = { user: 'hq-test', password: 'hq-test-gateway-password' }
const gatewayProviders = ['openai', 'anthropic', 'mistral', 'typesafe']
const testModelPrices = {
  'fake-model': 0.000009,
  'fake-large': 0.00003,
  'fake-medium': 0.000015,
  'fake-small': 0.000006,
  'claude-opus-5-5': 0.000005,
  'claude-sonnet-5-5': 0.000003,
  'claude-haiku-5-5': 0.000001,
  'mistral-large-latest': 0.000004,
  'mistral-medium-latest': 0.000002,
  'mistral-small-latest': 0.0000005,
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
export type TestGateway = ReturnType<typeof testGatewayAt>

const docker = (...args: string[]) => spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })

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
  const containerName = `hq-test-gateway-${name}`
  const databaseName = `hq_test_gateway_${name}`
  const configFile = join(tmpdir(), `${containerName}.json`)
  const gatewayConfig = JSON.parse(readFileSync(new URL('../../../../infra/bifrost.json', import.meta.url), 'utf8'))
  const setup = { gatewayImage, port, fakeLlmUrl, oauthBase, gatewayConfig, gatewayProviders, testModelPrices }
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
  const running = docker('inspect', '-f', '{{.State.Running}} {{index .Config.Labels "hq.setup"}}', containerName)
  if (running.stdout.toString().trim() === `true ${setupHash}` && (await isReady()) && (await isSetUp())) {
    const { clients } = await gateway.call<{ clients: { config: { client_id: string } }[] | null }>('/api/mcp/clients')
    for (const { config } of clients ?? [])
      await gateway.call(`/api/mcp/client/${config.client_id}`, { method: 'DELETE' })
    return gateway
  }
  const postgresUrl = new URL(databaseUrl)
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
  writeFileSync(configFile, JSON.stringify({ ...gatewayConfig, config_store: store, logs_store: store }))
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
    `hq.setup=${setupHash}`,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-p',
    `127.0.0.1:${port}:8080`,
    '-v',
    `${configFile}:/app/data/config.json:ro`,
    '-e',
    'BIFROST_ENCRYPTION_KEY=hq-test-gateway-encryption-key',
    '-e',
    'BIFROST_SETUP_TOKEN=hq-test-gateway-setup-token',
    '-e',
    `BIFROST_ADMIN_USER=${testGatewayAdmin.user}`,
    '-e',
    `BIFROST_ADMIN_PASSWORD=${testGatewayAdmin.password}`,
    '-e',
    `HQ_GATEWAY_OAUTH_BASE=${oauthBase}`,
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
    const networkConfig = { base_url: fakeLlmUrl, default_request_timeout_in_seconds: 60, max_retries: 0 }
    for (const provider of ['fake', 'fake-small'])
      await gateway.call('/api/providers', {
        method: 'POST',
        body: {
          provider,
          keys: [],
          network_config: networkConfig,
          custom_provider_config: { base_provider_type: 'openai' },
        },
      })
    for (const provider of gatewayProviders)
      await gateway.call('/api/providers', {
        method: 'POST',
        body: { provider, keys: [], network_config: networkConfig },
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
  const { id: keyId } = await gateway.call<{ id: string }>('/api/providers/fake/keys', {
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
      provider_configs: [{ provider: 'fake', weight: 1, allowed_models: ['*'], key_ids: [keyId] }],
    },
  })
  const { workspaceId, id, userId } = aliceSeededCredential
  const write = async (writer: SeedWriter) => {
    await writer.execute(
      sql`update llm_credentials set secret_ref = ${`gateway:fake/${keyId}`} where workspace_id = ${workspaceId} and id = ${id}`,
    )
    await writer.execute(
      sql`insert into member_gateway_keys (workspace_id, user_id, virtual_key_id) values (${workspaceId}, ${userId}, ${virtual_key.id})`,
    )
  }
  return Object.assign(write, { keyId, virtualKeyId: virtual_key.id })
}
