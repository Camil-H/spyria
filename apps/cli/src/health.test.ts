import { expect, test } from 'bun:test'
import {
  backupNameOf,
  backupsToRemoveOf,
  diskProblemOf,
  productionProblemsIn,
  serviceProblemsOf,
  serviceStatesOf,
} from './health.ts'

const healthy = (Service: string) => ({ Service, State: 'running', Health: 'healthy' })

test('the services of the stack and of its profiles must run and be healthy', () => {
  const states = serviceStatesOf(
    [
      healthy('postgres'),
      healthy('server'),
      healthy('zero-cache'),
      { ...healthy('gateway'), Health: 'starting' },
      { Service: 'host', State: 'restarting' },
    ]
      .map((state) => JSON.stringify(state))
      .join('\n'),
  )
  expect(serviceProblemsOf(states, ['host', 'cloudflare'])).toEqual([
    'gateway is starting',
    'host is restarting',
    'cloudflared is not running',
  ])
  expect(serviceProblemsOf(serviceStatesOf(JSON.stringify(states)), [])).toEqual(['gateway is starting'])
  expect(serviceStatesOf('')).toEqual([])
})

test('the production check of the last server start is read from its logs', () => {
  const logs = [
    'spyria-server  | Spyria cannot start in production:',
    'spyria-server  | - SPYRIA_SETUP_TOKEN is required.',
    'spyria-server  | - SPYRIA_APP_ORIGIN must start with https://.',
    'spyria-server  | {"event.name":"server.started"}',
  ].join('\n')
  expect(productionProblemsIn(logs)).toEqual([
    'SPYRIA_SETUP_TOKEN is required.',
    'SPYRIA_APP_ORIGIN must start with https://.',
  ])
  expect(productionProblemsIn('spyria-server  | {"event.name":"server.started"}')).toEqual([])
})

test('less than 5 GiB of free disk is a problem', () => {
  expect(diskProblemOf(4 * 1024 * 1024)).toBe('Only 4.0 GiB of disk is free (at least 5 GiB is advised)')
  expect(diskProblemOf(6 * 1024 * 1024)).toBeUndefined()
})

test('backups are named by database and time, and only the newest of each database are kept', () => {
  expect(backupNameOf('spyria', new Date('2026-11-07T10:20:30.456Z'))).toBe('spyria-20261107T102030Z.dump')
  const files = [
    'spyria-20261101T000000Z.dump',
    'spyria-20261103T000000Z.dump',
    'spyria-20261102T000000Z.dump',
    'bifrost-20261101T000000Z.dump',
    'notes.txt',
  ]
  expect(backupsToRemoveOf(files, 2)).toEqual(['spyria-20261101T000000Z.dump'])
  expect(backupsToRemoveOf(files, 1).toSorted()).toEqual([
    'spyria-20261101T000000Z.dump',
    'spyria-20261102T000000Z.dump',
  ])
})
