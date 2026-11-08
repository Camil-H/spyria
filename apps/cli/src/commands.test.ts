import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { changeSignInApp, doctor, upgrade } from './commands.ts'
import { parseEnvironment, serializeEnvironment } from './environment.ts'
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
  *sso:sign-in-app*) cat > "$FAKE_DOCKER/stdin" ;;
  *"ps --all --format json"*) cat "$FAKE_DOCKER/ps.json" ;;
  *"images --format json"*) printf '[]' ;;
  *"ps --all --quiet host"*) cat "$FAKE_DOCKER/host-container" 2>/dev/null ;;
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

const installed = {
  SPYRIA_DEPLOYMENT: 'spyria',
  SPYRIA_VERSION: '1.2.0',
  SPYRIA_APP_ORIGIN: 'https://spyria.example.com',
  SPYRIA_LOCAL_PORT: String(health.port),
  CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token',
  COMPOSE_PROFILES: 'host,cloudflare',
}
beforeEach(() => {
  writeFileSync(join(install, 'compose.yml'), 'old compose')
  writeFileSync(join(install, 'bifrost.json'), '{"release":"1.2.0"}')
  writeFileSync(join(install, '.env'), serializeEnvironment(installed), { mode: 0o600 })
  rmSync(join(fakeDocker, 'calls'), { force: true })
  rmSync(join(fakeDocker, 'stdin'), { force: true })
  rmSync(join(fakeDocker, 'host-container'), { force: true })
  rmSync(join(fakeDocker, 'runtimes'), { force: true })
})
const calls = () =>
  existsSync(join(fakeDocker, 'calls')) ? readFileSync(join(fakeDocker, 'calls'), 'utf8').trim().split('\n') : []
const indexOfCall = (part: string) => calls().findIndex((call) => call.includes(part))
const environment = () => parseEnvironment(readFileSync(join(install, '.env'), 'utf8'))

test('spyria upgrade backs up both databases while the old release is still in place, then writes the new release and starts it', async () => {
  await upgrade(install, parseFlags(['upgrade', '1.3.0', '--folder', install]), { fileUrlOf })
  expect(readFileSync(join(fakeDocker, 'compose-at-backup'), 'utf8')).toBe('old compose')
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
  expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toBe('old compose')
  expect(environment()).toEqual(installed)
})

test('spyria sign-in-app hands the trimmed secret to the operator command on standard input, never as an argument, and refuses an empty one', async () => {
  const flags = parseFlags(['sign-in-app', '--client-id', 'garage-app', '--folder', install])
  await changeSignInApp(install, flags, { readSecret: async () => '  garage-secret\n' })
  expect(readFileSync(join(fakeDocker, 'stdin'), 'utf8')).toBe('garage-secret')
  expect(calls()).toHaveLength(1)
  expect(calls()[0]).toContain(
    'exec -T server bun apps/server/src/operator-cli.ts sso:sign-in-app --client-id garage-app',
  )
  expect(calls()[0]).not.toContain('garage-secret')

  const refusal = await changeSignInApp(install, flags, { readSecret: async () => ' \n' }).catch(
    (error: Error) => error.message,
  )
  expect(refusal).toBe('The client secret is required, typed or on standard input')
  expect(calls()).toHaveLength(1)
})

test('spyria doctor is satisfied when every expected service runs and names the one that does not', () => {
  const services = ['postgres', 'server', 'zero-cache', 'gateway', 'host', 'cloudflared']
  const psOf = (stateOf: (service: string) => string) =>
    writeFileSync(
      join(fakeDocker, 'ps.json'),
      services.map((service) => JSON.stringify({ Service: service, State: stateOf(service) })).join('\n'),
    )
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

test('setting up again without a runtime host removes the host container this machine runs and stops its runtimes, and touches nothing when there was none', async () => {
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
  expect(indexOfCall('rm --stop --force host')).toBe(-1)
})
