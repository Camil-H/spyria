import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import postgres from 'postgres'
import { databaseUrlOf, isLeftoverTestDockerObject, removeLeftoversOfKilledRuns } from './testing.ts'

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
