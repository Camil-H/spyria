import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
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

export const buildTemplateDatabase = async (name = templateDatabaseName) => {
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
      ZERO_LOG_LEVEL: process.env.HQ_ZERO_LOG_LEVEL ?? 'error',
      ZERO_ENABLE_TELEMETRY: 'false',
    },
  })
  let errorOutput = ''
  zeroCache.stderr?.on('data', (chunk) => {
    writeSync(logFile, chunk)
    errorOutput = `${errorOutput}${chunk}`.slice(-4000)
  })
  const url = `http://localhost:${port}`
  for (let attempt = 1; (await httpStatusOf(`${url}/keepalive`)) !== 200; attempt++) {
    if (zeroCache.exitCode !== null || attempt === 600) {
      await stopProcessGroup(zeroCache)
      throw new Error(`zero-cache on port ${port} did not start: ${errorOutput}`)
    }
    await sleep(50)
  }
  return { url, stop: () => stopProcessGroup(zeroCache) }
}

const gatewayImage = 'maximhq/bifrost:v2.2.6@sha256:d0b4708ace1aa175766f94afa715fd9bba3a1b56c1dc2afff15a21edf3ae4e2a'
export const testGatewayAdmin = { user: 'hq-test', password: 'hq-test-gateway-password' }
const gatewayProviders = ['openai', 'anthropic', 'mistral']

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
  const configFile = join(tmpdir(), `${containerName}-${crypto.randomUUID()}.json`)
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
  const gatewayConfig = JSON.parse(readFileSync(new URL('../../../../infra/bifrost.json', import.meta.url), 'utf8'))
  writeFileSync(configFile, JSON.stringify({ ...gatewayConfig, config_store: store, logs_store: store }))
  const stop = async () => {
    docker('rm', '-fv', containerName)
    rmSync(configFile, { force: true })
    await dropDatabase(databaseName)
  }
  const started = docker(
    'run',
    '-d',
    '--name',
    containerName,
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
    await stop()
    throw new Error(`The test gateway did not start: ${started.stderr.toString()}`)
  }
  const gateway = testGatewayAt(`http://127.0.0.1:${port}`)
  try {
    let lastAnswer: number | string = 'nothing'
    const isReady = async () => {
      lastAnswer = await httpStatusOf(`${gateway.url}/api/providers`, { authorization: gatewayAuthorization })
      return lastAnswer === 200
    }
    for (let attempt = 1; !(await isReady()); attempt++) {
      if (attempt === 480) throw new Error(`The test gateway did not become ready (last answer: ${lastAnswer})`)
      await sleep(250)
    }
    const networkConfig = { base_url: fakeLlmUrl, default_request_timeout_in_seconds: 60, max_retries: 0 }
    await gateway.call('/api/providers', {
      method: 'POST',
      body: {
        provider: 'fake',
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
    await gateway.call('/api/governance/pricing-overrides', {
      method: 'POST',
      body: {
        name: 'fake-model',
        scope_kind: 'global',
        match_type: 'exact',
        pattern: 'fake-model',
        request_types: ['chat_completion'],
        patch: { input_cost_per_token: 0.000009, output_cost_per_token: 0.000009 },
      },
    })
  } catch (error) {
    await stop()
    throw error
  }
  return { ...gateway, stop }
}

const aliceSeededCredential = {
  workspaceId: 'workspace-acme',
  id: 'credential-alice-anthropic',
  userId: 'member-alice',
}
type SeedWriter = { execute: (query: SQL) => Promise<unknown> }

export const prepareSeededGatewayKeys = async (gateway: TestGateway) => {
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
  return async (writer: SeedWriter) => {
    await writer.execute(
      sql`update llm_credentials set secret_ref = ${`gateway:fake/${keyId}`} where workspace_id = ${workspaceId} and id = ${id}`,
    )
    await writer.execute(
      sql`insert into member_gateway_keys (workspace_id, user_id, virtual_key_id) values (${workspaceId}, ${userId}, ${virtual_key.id})`,
    )
  }
}
