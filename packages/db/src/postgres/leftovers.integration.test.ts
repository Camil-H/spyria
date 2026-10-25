import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { databaseUrlOf, dropDatabase, isLeftoverTestDockerObject, removeLeftoversOfKilledRuns } from './testing.ts'

const docker = (...args: string[]) => spawnSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()

test('only names of killed test runs older than 30 minutes are Docker leftovers', () => {
  const leftovers = ['spyria-test-1a2b3c4d-host', 'spyria-test-1a2b3c4d-rt-x-ws', 'spyria-test-e2e-host']
  const kept = [
    ...['spyria-test-postgres', 'spyria-test-dex', 'spyria-test-gateway-e2e', 'spyria-test-harnesses'],
    ...['spyria-postgres', 'spyria-postgres-data', 'spyria-host', 'spyria-rt-1a2b3c4d-ws', 'spyria-network'],
    ...['spyria-prod-postgres', 'spyria-smoke-1a2b3c4d-server', 'cnt-dev', 'blitz-1a2b3c4d-db-1'],
    ...['spyria-test-1A2B3C4D-host', 'spyria-test-1a2b3c4-host', 'spyria-tests-1a2b3c4d-host', 'xspyria-test-e2e-host'],
  ]
  expect(leftovers.filter((name) => isLeftoverTestDockerObject(name, hourAgo))).toEqual(leftovers)
  expect(kept.filter((name) => isLeftoverTestDockerObject(name, hourAgo))).toEqual([])
  expect(isLeftoverTestDockerObject('spyria-test-1a2b3c4d-host', new Date().toISOString())).toBe(false)
})

test('the sweep drops idle test databases and test slots and leaves similar names and fresh Docker objects', async () => {
  const id = crypto.randomUUID().replaceAll('-', '')
  const testDatabase = `spyria_test_${id}`
  const similarDatabase = `spyria_testx_${id}`
  const testSlot = `spyriatest_${id}`
  const similarSlot = `spyria_0_${id}`
  const freshVolume = `spyria-test-${id.slice(0, 8)}-ws`
  const similarVolume = `spyria-tests-${id.slice(0, 8)}-ws`
  const admin = postgres(databaseUrlOf('postgres'), { onnotice: () => {} })
  try {
    for (const database of [testDatabase, similarDatabase]) await admin.unsafe(`create database "${database}"`)
    for (const slot of [testSlot, similarSlot])
      await admin`select pg_create_logical_replication_slot(${slot}, 'pgoutput')`
    for (const volume of [freshVolume, similarVolume]) expect(docker('volume', 'create', volume).status).toBe(0)

    await removeLeftoversOfKilledRuns()

    const databases = await admin<{ datname: string }[]>`select datname from pg_database
      where datname in (${testDatabase}, ${similarDatabase})`
    expect(databases.map(({ datname }) => datname)).toEqual([similarDatabase])
    const slots = await admin<{ slot_name: string }[]>`select slot_name from pg_replication_slots
      where slot_name in (${testSlot}, ${similarSlot})`
    expect(slots.map(({ slot_name }) => slot_name)).toEqual([similarSlot])
    for (const volume of [freshVolume, similarVolume]) expect(docker('volume', 'inspect', volume).status).toBe(0)
  } finally {
    await admin`select pg_drop_replication_slot(slot_name) from pg_replication_slots
      where slot_name in (${testSlot}, ${similarSlot})`
    for (const database of [testDatabase, similarDatabase]) await admin.unsafe(`drop database if exists "${database}"`)
    await admin.end()
    docker('volume', 'rm', freshVolume, similarVolume)
  }
})

test('dropping a test database first drops the replication slots a stopped zero-cache left in it', async () => {
  const name = `spyria_test_${crypto.randomUUID().replaceAll('-', '')}`
  const slot = `spyriatest_${name.slice(-12)}`
  const admin = postgres(databaseUrlOf('postgres'), { onnotice: () => {} })
  try {
    await admin.unsafe(`create database "${name}"`)
    const replicated = postgres(databaseUrlOf(name), { onnotice: () => {} })
    await replicated`select pg_create_logical_replication_slot(${slot}, 'pgoutput')`
    await replicated.end()

    await dropDatabase(name)

    expect(await admin`select 1 from pg_database where datname = ${name}`).toHaveLength(0)
    expect(await admin`select 1 from pg_replication_slots where slot_name = ${slot}`).toHaveLength(0)
  } finally {
    await admin`select pg_drop_replication_slot(slot_name) from pg_replication_slots where slot_name = ${slot}`
    await admin.unsafe(`drop database if exists "${name}"`)
    await admin.end()
  }
})
