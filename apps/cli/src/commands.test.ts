import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctor, restore, upgrade } from './commands.ts'
import { parseEnvironment, serializeEnvironment, withSecrets } from './environment.ts'
import { parseFlags } from './flags.ts'
import { setup } from './setup.ts'

const root = mkdtempSync(join(tmpdir(), 'spyria-commands-'))
const install = join(root, 'install')
const fakeBin = join(root, 'bin')
const fakeDocker = join(root, 'docker')
mkdirSync(install)
mkdirSync(fakeBin)
mkdirSync(fakeDocker)
writeFileSync(
  join(fakeBin, 'docker'),
  `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER/calls"
case "$*" in
  *pg_dump*)
    cp "$FAKE_INSTALL/compose.yml" "$FAKE_DOCKER/compose-at-backup"
    cp "$FAKE_INSTALL/.env" "$FAKE_DOCKER/env-at-backup"
    printf 'dump' ;;
  *has-workspace*) cat "$FAKE_DOCKER/has-workspace" 2>/dev/null ;;
  *pg_database*)
    [ "$(cat "$FAKE_DOCKER/database-exists" 2>/dev/null)" = unknown ] && exit 2
    cat "$FAKE_DOCKER/database-exists" 2>/dev/null ;;
  *"ps --all --format json"*) cat "$FAKE_DOCKER/ps.json" ;;
  *"images --format json"*) printf '[]' ;;
  *"ps --all --quiet host"*) cat "$FAKE_DOCKER/host-container" 2>/dev/null ;;
  "volume ls "*)
    [ -f "$FAKE_DOCKER/daemon-down" ] && exit 1
    cat "$FAKE_DOCKER/volumes" 2>/dev/null ;;
  "volume rm "*) [ -f "$FAKE_DOCKER/volume-in-use" ] && { echo "Error response from daemon: volume is in use" >&2; exit 1; } ;;
  "ps -q --filter label=spyria.managed=1 --filter name=^spyria-rt-") cat "$FAKE_DOCKER/runtimes" 2>/dev/null ;;
esac
exit 0
`,
)
chmodSync(join(fakeBin, 'docker'), 0o755)

const health = Bun.serve({ port: 0, fetch: () => new Response('ok') })
const release = Bun.serve({
  port: 0,
  fetch: (request) => {
    const { pathname } = new URL(request.url)
    if (pathname === '/v1.3.0/deploy/compose.prod.yml') return new Response('new compose')
    if (pathname === '/v1.3.0/deploy/bifrost.json') return new Response('{"release":"1.3.0"}')
    return new Response('not found', { status: 404 })
  },
})
const fileUrlOf = (version: string, path: string) => `${release.url.origin}/v${version}/${path}`
const originalPath = process.env.PATH
process.env.PATH = `${fakeBin}:${originalPath}`
process.env.FAKE_DOCKER = fakeDocker
process.env.FAKE_INSTALL = install
const quiet = spyOn(console, 'log').mockImplementation(() => undefined)
afterAll(() => {
  quiet.mockRestore()
  process.env.PATH = originalPath
  health.stop(true)
  release.stop(true)
  rmSync(root, { recursive: true, force: true })
})

const oldCompose = `name: \${SPYRIA_DEPLOYMENT}\n# release 1.2.0\n`
const installed = {
  SPYRIA_DEPLOYMENT: 'spyria',
  SPYRIA_VERSION: '1.2.0',
  SPYRIA_APP_ORIGIN: 'https://spyria.example.com',
  SPYRIA_LOCAL_PORT: String(health.port),
  CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token',
  COMPOSE_PROFILES: 'host,cloudflare',
}
beforeEach(() => {
  writeFileSync(join(install, 'compose.yml'), oldCompose)
  writeFileSync(join(install, 'bifrost.json'), '{"release":"1.2.0"}')
  writeFileSync(join(install, '.env'), serializeEnvironment(installed), { mode: 0o600 })
  rmSync(join(fakeDocker, 'calls'), { force: true })
  rmSync(join(fakeDocker, 'stdin'), { force: true })
  rmSync(join(fakeDocker, 'compose-at-backup'), { force: true })
  rmSync(join(fakeDocker, 'env-at-backup'), { force: true })
  rmSync(join(fakeDocker, 'host-container'), { force: true })
  rmSync(join(fakeDocker, 'runtimes'), { force: true })
  rmSync(join(fakeDocker, 'volume-in-use'), { force: true })
  rmSync(join(fakeDocker, 'volumes'), { force: true })
  rmSync(join(fakeDocker, 'daemon-down'), { force: true })
  writeFileSync(join(fakeDocker, 'has-workspace'), 'no\n')
  writeFileSync(join(fakeDocker, 'database-exists'), '1\n')
})
const calls = () =>
  existsSync(join(fakeDocker, 'calls')) ? readFileSync(join(fakeDocker, 'calls'), 'utf8').trim().split('\n') : []
const indexOfCall = (part: string) => calls().findIndex((call) => call.includes(part))
const environment = () => parseEnvironment(readFileSync(join(install, '.env'), 'utf8'))

test('spyria upgrade backs up both databases while the old release is still in place, then writes the new release and starts it', async () => {
  await upgrade(install, parseFlags(['upgrade', '1.3.0', '--folder', install]), { fileUrlOf })
  expect(readFileSync(join(fakeDocker, 'compose-at-backup'), 'utf8')).toBe(oldCompose)
  expect(parseEnvironment(readFileSync(join(fakeDocker, 'env-at-backup'), 'utf8')).SPYRIA_VERSION).toBe('1.2.0')
  expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toBe('new compose')
  expect(readFileSync(join(install, 'bifrost.json'), 'utf8')).toBe('{"release":"1.3.0"}')
  expect(environment()).toEqual({ ...installed, SPYRIA_VERSION: '1.3.0' })
  const dumps = calls().filter((call) => call.includes('pg_dump'))
  expect(dumps.map((call) => call.split(' -d ')[1]?.split(' ')[0])).toEqual(['spyria', 'bifrost'])
  expect(indexOfCall('pg_dump')).toBeLessThan(indexOfCall('pull --quiet'))
  expect(indexOfCall('pull --quiet')).toBeLessThan(indexOfCall('up -d --remove-orphans'))
})

test('spyria upgrade to a version without release files changes nothing and backs nothing up', async () => {
  const refusal = await upgrade(install, parseFlags(['upgrade', '9.9.9', '--folder', install]), { fileUrlOf }).catch(
    (error: Error) => error.message,
  )
  expect(refusal).toBe('Version 9.9.9 has no deploy/compose.prod.yml (404)')
  expect(calls()).toEqual([])
  expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toBe(oldCompose)
  expect(environment()).toEqual(installed)
})

test('spyria setup --version backs up both databases while the old release is still in place, and a setup that keeps the version backs nothing up', async () => {
  await setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.3.0']), {
    processEnvironment: {},
    workspaceExistsIn: () => false,
  })
  expect(readFileSync(join(fakeDocker, 'compose-at-backup'), 'utf8')).toBe(oldCompose)
  expect(parseEnvironment(readFileSync(join(fakeDocker, 'env-at-backup'), 'utf8')).SPYRIA_VERSION).toBe('1.2.0')
  expect(calls().filter((call) => call.includes('pg_dump'))).toHaveLength(2)
  expect(environment().SPYRIA_VERSION).toBe('1.3.0')

  rmSync(join(fakeDocker, 'calls'), { force: true })
  await setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.3.0']), {
    processEnvironment: {},
    workspaceExistsIn: () => false,
  })
  expect(calls().filter((call) => call.includes('pg_dump'))).toEqual([])
})

test('spyria restore replaces a database only once confirmed, and backs it up as it is first', async () => {
  const restored = 'spyria-20260101T000000Z.dump'
  rmSync(join(install, 'backups'), { recursive: true, force: true })
  mkdirSync(join(install, 'backups'))
  writeFileSync(join(install, 'backups', restored), 'dump')
  const questions: string[] = []
  const restoreAnswering = (answer: boolean, extra: string[] = []) =>
    restore(install, parseFlags(['restore', `backups/${restored}`, '--folder', install, ...extra]), {
      confirms: (question) => {
        questions.push(question)
        return answer
      },
    })

  const refusal = await restoreAnswering(false).catch((error: Error) => error.message)
  expect(refusal).toBe('Nothing was restored: answer y, or pass --yes to restore without the question')
  expect(questions).toEqual([
    `Replace the spyria database with backups/${restored}? What changed since that backup is lost`,
  ])
  expect(calls().filter((call) => /pg_dump|stop|dropdb|createdb/.test(call))).toEqual([])
  expect(readdirSync(join(install, 'backups'))).toEqual([restored])

  await restoreAnswering(true)
  const safetyCopies = readdirSync(join(install, 'backups')).filter((file) => file !== restored)
  expect(safetyCopies).toHaveLength(1)
  expect(safetyCopies[0]).toStartWith('spyria-')
  expect(calls().filter((call) => call.includes('pg_dump'))).toHaveLength(1)
  expect(indexOfCall('pg_dump')).toBeLessThan(indexOfCall('dropdb'))

  rmSync(join(fakeDocker, 'calls'), { force: true })
  await restoreAnswering(false, ['--yes'])
  expect(questions).toHaveLength(2)
  expect(indexOfCall('dropdb')).toBeGreaterThan(indexOfCall('pg_dump'))
})

test('spyria restore changes nothing when Postgres does not say whether the database exists, rather than skip its backup', async () => {
  const restored = 'spyria-20260101T000000Z.dump'
  mkdirSync(join(install, 'backups'), { recursive: true })
  writeFileSync(join(install, 'backups', restored), 'dump')
  writeFileSync(join(fakeDocker, 'database-exists'), 'unknown')
  const refusal = await restore(
    install,
    parseFlags(['restore', `backups/${restored}`, '--yes', '--folder', install]),
  ).catch((error: Error) => error.message)
  expect(refusal).toBe('Postgres did not say whether the spyria database exists: nothing was changed')
  expect(calls().filter((call) => /pg_dump|stop|dropdb|createdb/.test(call))).toEqual([])
})

test('spyria restore brings back a database that no longer exists, with nothing to back up first', async () => {
  const restored = 'spyria-20260101T000000Z.dump'
  mkdirSync(join(install, 'backups'), { recursive: true })
  writeFileSync(join(install, 'backups', restored), 'dump')
  rmSync(join(fakeDocker, 'database-exists'))
  await restore(install, parseFlags(['restore', `backups/${restored}`, '--yes', '--folder', install]))
  expect(calls().filter((call) => call.includes('pg_dump'))).toEqual([])
  expect(indexOfCall('createdb')).toBeGreaterThan(-1)
  expect(indexOfCall('pg_restore -U spyria -d spyria')).toBeGreaterThan(indexOfCall('createdb'))
})

test('spyria doctor is satisfied when every expected service runs and names the one that does not', () => {
  const services = ['postgres', 'server', 'zero-cache', 'gateway', 'host', 'cloudflared']
  const psOf = (stateOf: (service: string) => string) =>
    writeFileSync(
      join(fakeDocker, 'ps.json'),
      services.map((service) => JSON.stringify({ Service: service, State: stateOf(service) })).join('\n'),
    )
  writeFileSync(join(install, '.env'), serializeEnvironment({ ...installed, ...withSecrets({}) }))
  psOf(() => 'running')
  expect(doctor(install)).toBe(true)
  psOf((service) => (service === 'zero-cache' ? 'exited' : 'running'))
  const printed: string[] = []
  quiet.mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    expect(doctor(install)).toBe(false)
  } finally {
    quiet.mockImplementation(() => undefined)
  }
  expect(printed).toContain('✗ zero-cache is exited')
})

test('spyria doctor names a .env others can read, a default credential and a port published beyond this machine', () => {
  writeFileSync(
    join(install, '.env'),
    serializeEnvironment({ ...installed, ...withSecrets({}), SPYRIA_POSTGRES_PASSWORD: 'spyria' }),
  )
  chmodSync(join(install, '.env'), 0o644)
  writeFileSync(
    join(fakeDocker, 'ps.json'),
    ['postgres', 'server', 'zero-cache', 'gateway', 'host', 'cloudflared']
      .map((service) =>
        JSON.stringify({
          Service: service,
          State: 'running',
          Publishers: service === 'server' ? [{ URL: '0.0.0.0', TargetPort: 3000, PublishedPort: 3300 }] : [],
        }),
      )
      .join('\n'),
  )
  const printed: string[] = []
  quiet.mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    expect(doctor(install)).toBe(false)
  } finally {
    quiet.mockImplementation(() => undefined)
    chmodSync(join(install, '.env'), 0o600)
  }
  expect(printed.filter((line) => line.startsWith('✗'))).toEqual([
    '✗ SPYRIA_POSTGRES_PASSWORD is a default or short value: replace it as the troubleshooting guide shows',
    '✗ .env is open to other users of this machine (mode 644): run chmod 600 on it',
    '✗ server publishes port 3300 on every address, reachable from other machines: publish it on 127.0.0.1 only',
  ])
})

test('setting up again without a runtime host removes the host container this machine runs and stops its runtimes, touches nothing when there was none, and turning the host back on forgets the pairing a leftover host kept', async () => {
  writeFileSync(join(fakeDocker, 'host-container'), 'host-container-id\n')
  writeFileSync(join(fakeDocker, 'runtimes'), 'runtime-a\nruntime-b\n')
  const printed: string[] = []
  quiet.mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    await setup(parseFlags(['setup', '--unattended', '--no-host', '--folder', install, '--version', '1.2.0']), {
      processEnvironment: {},
    })
  } finally {
    quiet.mockImplementation(() => undefined)
  }
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  expect(environment().SPYRIA_INSTALL_HOST_TOKEN).toBeUndefined()
  expect(indexOfCall('--profile host rm --stop --force host')).toBeGreaterThan(-1)
  expect(calls()).toContain('stop runtime-a runtime-b')
  expect(indexOfCall('stop runtime-a runtime-b')).toBeLessThan(indexOfCall('up -d --remove-orphans'))
  expect(printed.join('\n')).toContain('its 2 runtimes are stopped, their files kept')

  rmSync(join(fakeDocker, 'calls'), { force: true })
  rmSync(join(fakeDocker, 'host-container'), { force: true })
  await setup(parseFlags(['setup', '--unattended', '--no-host', '--folder', install, '--version', '1.2.0']), {
    processEnvironment: {},
  })
  expect(indexOfCall('rm --stop --force host')).toBe(-1)
  expect(calls().some((call) => call.startsWith('stop '))).toBe(false)

  rmSync(join(fakeDocker, 'calls'), { force: true })
  writeFileSync(join(fakeDocker, 'host-container'), 'host-container-id\n')
  await setup(parseFlags(['setup', '--unattended', '--host', '--folder', install, '--version', '1.2.0']), {
    processEnvironment: {},
  })
  expect(environment().COMPOSE_PROFILES).toBe('host,cloudflare')
  expect(indexOfCall('rm --stop --force host')).toBeGreaterThan(-1)
  expect(indexOfCall('volume rm spyria-host')).toBeGreaterThan(indexOfCall('rm --stop --force host'))
  expect(indexOfCall('volume rm spyria-host')).toBeLessThan(indexOfCall('up -d --remove-orphans'))

  rmSync(join(fakeDocker, 'calls'), { force: true })
  await setup(parseFlags(['setup', '--unattended', '--host', '--folder', install, '--version', '1.2.0']), {
    processEnvironment: {},
  })
  expect(indexOfCall('rm --stop --force host')).toBe(-1)
  expect(indexOfCall('volume rm')).toBe(-1)
})

test("turning this machine's host on once a workspace exists takes the command of Add runtime host and refuses to go on without it or when Spyria does not answer, while before the first workspace the install code still serves", async () => {
  writeFileSync(join(install, '.env'), serializeEnvironment({ ...installed, COMPOSE_PROFILES: 'cloudflare' }), {
    mode: 0o600,
  })
  writeFileSync(join(fakeDocker, 'has-workspace'), 'yes\n')
  const hostTurnedOn = (processEnvironment: Record<string, string>) =>
    setup(parseFlags(['setup', '--unattended', '--host', '--folder', install, '--version', '1.2.0']), {
      processEnvironment,
    })

  const refusal = await hostTurnedOn({}).catch((error: Error) => error.message)
  expect(refusal).toBe('SPYRIA_SETUP_HOST_CLAIM_URL is required')
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  rmSync(join(fakeDocker, 'has-workspace'))
  const unanswered = await hostTurnedOn({}).catch((error: Error) => error.message)
  expect(unanswered).toStartWith('Setup cannot tell whether a workspace exists, since Spyria does not answer')
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  expect(indexOfCall('up -d')).toBe(-1)

  writeFileSync(join(fakeDocker, 'has-workspace'), 'yes\n')
  await hostTurnedOn({ SPYRIA_SETUP_HOST_CLAIM_URL: 'https://spyria.example.com/h/ABCD2345' })
  expect(environment()).toMatchObject({
    COMPOSE_PROFILES: 'host,cloudflare',
    SPYRIA_HOST_CLAIM_URL: 'http://server:3000/h/ABCD2345',
  })
  expect(environment().SPYRIA_INSTALL_HOST_TOKEN).toBeUndefined()
  expect(indexOfCall('volume rm spyria-host')).toBeLessThan(indexOfCall('up -d --remove-orphans'))
  expect(indexOfCall('volume rm spyria-host')).toBeGreaterThan(-1)

  rmSync(join(fakeDocker, 'calls'), { force: true })
  await hostTurnedOn({ SPYRIA_SETUP_HOST_CLAIM_URL: 'https://spyria.example.com/h/ABCD2345' })
  expect(indexOfCall('volume rm')).toBe(-1)
  writeFileSync(join(fakeDocker, 'volume-in-use'), '')
  const inUse = await hostTurnedOn({ SPYRIA_SETUP_HOST_CLAIM_URL: 'https://spyria.example.com/h/WXYZ6789' }).catch(
    (error: Error) => error.message,
  )
  expect(inUse).toBe('Removing spyria-host failed: Error response from daemon: volume is in use')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBe('http://server:3000/h/ABCD2345')
  rmSync(join(fakeDocker, 'volume-in-use'))
  await hostTurnedOn({ SPYRIA_SETUP_HOST_CLAIM_URL: 'https://spyria.example.com/h/WXYZ6789' })
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBe('http://server:3000/h/WXYZ6789')
  expect(indexOfCall('volume rm spyria-host')).toBeGreaterThan(-1)

  writeFileSync(join(install, '.env'), serializeEnvironment({ ...installed, COMPOSE_PROFILES: 'cloudflare' }), {
    mode: 0o600,
  })
  writeFileSync(join(fakeDocker, 'has-workspace'), 'no\n')
  await hostTurnedOn({})
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBe(`http://server:3000/h/${environment().SPYRIA_INSTALL_HOST_TOKEN}`)
})

test('setup without the secrets of a deployment whose data this machine still holds refuses before writing anything, also when Docker does not answer, and does not ask Docker once the secrets are back', async () => {
  const secrets = withSecrets({})
  rmSync(join(install, '.env'))
  writeFileSync(
    join(fakeDocker, 'volumes'),
    'spyria-postgres-data\nspyria-gateway-data\nspyria-postgres-data-old\nother-spyria-zero-data\n',
  )
  const setUp = (extra: string[] = []) =>
    setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0'],
        ...['--hostname', 'spyria.example.com', ...extra],
      ]),
      {
        cloudflareApiUrl: 'http://127.0.0.1:9',
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 'cloudflare-api-token' },
        workspaceExistsIn: () => false,
      },
    ).catch((error: Error) => error.message)

  expect(await setUp()).toBe(
    `This machine holds the data of an earlier deployment named spyria (spyria-postgres-data, spyria-gateway-data), but ${install} has no .env with its secrets: put back the .env you copied off the machine with your backups and run setup again, choose another deployment name with --name, or, to start over without that data, remove it with docker volume rm spyria-postgres-data spyria-gateway-data`,
  )
  expect(existsSync(join(install, '.env'))).toBe(false)
  expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toBe(oldCompose)

  writeFileSync(join(fakeDocker, 'daemon-down'), '')
  expect(await setUp(['--name', 'other'])).toBe(
    'Docker does not answer, so setup cannot tell whether this machine holds the data of an earlier deployment: start Docker and run setup again',
  )
  rmSync(join(fakeDocker, 'daemon-down'))

  writeFileSync(join(install, '.env'), serializeEnvironment({ ...installed, ...secrets }), { mode: 0o600 })
  rmSync(join(fakeDocker, 'calls'), { force: true })
  await setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0']), {
    processEnvironment: {},
    workspaceExistsIn: () => false,
  })
  expect(indexOfCall('volume ls')).toBe(-1)
  expect(environment()).toMatchObject(secrets)
})
