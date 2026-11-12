import { expect, test } from 'bun:test'
import { withSecrets } from './environment.ts'
import {
  backupNameOf,
  backupsToRemoveOf,
  credentialProblemsOf,
  diskProblemOf,
  environmentFileModeProblemOf,
  productionProblemsIn,
  publishedPortProblemsOf,
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

test('a port published beyond this machine is a problem, once per service and port, while loopback and unpublished ports are not', () => {
  const states = serviceStatesOf(
    [
      {
        ...healthy('server'),
        Publishers: [
          { URL: '127.0.0.1', TargetPort: 3000, PublishedPort: 3300 },
          { URL: '::1', TargetPort: 3000, PublishedPort: 3300 },
        ],
      },
      {
        ...healthy('postgres'),
        Publishers: [
          { URL: '0.0.0.0', TargetPort: 5432, PublishedPort: 5432 },
          { URL: '0.0.0.0', TargetPort: 5432, PublishedPort: 5432 },
          { URL: '', TargetPort: 5433, PublishedPort: 0 },
        ],
      },
      { ...healthy('gateway'), Publishers: null },
    ]
      .map((state) => JSON.stringify(state))
      .join('\n'),
  )
  expect(publishedPortProblemsOf(states)).toEqual([
    'postgres publishes port 5432 on 0.0.0.0, reachable from other machines: publish it on 127.0.0.1 only',
  ])
})

test('.env readable by anyone but its owner is a problem', () => {
  expect(environmentFileModeProblemOf(0o100600)).toBeUndefined()
  expect(environmentFileModeProblemOf(0o100400)).toBeUndefined()
  expect(environmentFileModeProblemOf(0o100644)).toBe(
    '.env is readable by other users of this machine (mode 644): run chmod 600 on it',
  )
  expect(environmentFileModeProblemOf(0o100640)).toBeDefined()
})

test('a missing, short or development default secret, or a default gateway admin, is a problem', () => {
  const generated = withSecrets({})
  expect(credentialProblemsOf(generated)).toEqual([])
  expect(
    credentialProblemsOf({
      ...generated,
      SPYRIA_POSTGRES_PASSWORD: 'spyria',
      SPYRIA_GATEWAY_ADMIN_PASSWORD: 'spyria-dev-gateway-with-a-long-enough-suffix',
      SPYRIA_ZERO_ADMIN_PASSWORD: 'short',
      SPYRIA_SECRETS_KEY: '',
      SPYRIA_GATEWAY_ADMIN_USER: 'spyria',
    }),
  ).toEqual([
    'SPYRIA_SECRETS_KEY is missing from .env: run spyria setup again, which generates it',
    'SPYRIA_GATEWAY_ADMIN_PASSWORD is a default or short value: give it a random one of at least 32 characters',
    'SPYRIA_POSTGRES_PASSWORD is a default or short value: give it a random one of at least 32 characters',
    'SPYRIA_ZERO_ADMIN_PASSWORD is a default or short value: give it a random one of at least 32 characters',
    'SPYRIA_GATEWAY_ADMIN_USER is a development default: give it another name',
  ])
})
