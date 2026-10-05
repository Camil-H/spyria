import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { createDatabase, databaseUrl } from './client.ts'
import { resetDatabase } from './seed.ts'

const templateDatabaseName = 'hq_test_template'

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
      await database.$client.end()
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

const zeroCacheCli = new URL('../../node_modules/@rocicorp/zero/out/zero/src/cli.js', import.meta.url).pathname

const stopProcessGroup = async (process: ChildProcess) => {
  if (process.exitCode !== null || process.signalCode !== null) return
  const exited = once(process, 'exit')
  globalThis.process.kill(-(process.pid ?? 0), 'SIGTERM')
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
  const zeroCache = spawn('node', [zeroCacheCli], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
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
      ZERO_LOG_LEVEL: 'error',
      ZERO_ENABLE_TELEMETRY: 'false',
    },
  })
  let errorOutput = ''
  zeroCache.stderr?.on('data', (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-4000)
  })
  const url = `http://localhost:${port}`
  for (
    let attempt = 1;
    !(await fetch(`${url}/keepalive`).then(
      (response) => response.ok,
      () => false,
    ));
    attempt++
  ) {
    if (zeroCache.exitCode !== null || attempt === 600) {
      await stopProcessGroup(zeroCache)
      throw new Error(`zero-cache on port ${port} did not start: ${errorOutput}`)
    }
    await sleep(50)
  }
  return { url, stop: () => stopProcessGroup(zeroCache) }
}
