import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvironment } from './environment.ts'
import { parseFlags } from './flags.ts'
import { setup } from './setup.ts'

const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const tunnelNames: string[] = []
const cloudflare = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/zones') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }])
    if (pathname === '/accounts/account-1/cfd_tunnel' && request.method === 'POST') {
      tunnelNames.push(((await request.json()) as { name: string }).name)
      return ok({ id: 'tunnel-1', name: tunnelNames.at(-1) })
    }
    if (pathname.endsWith('/token')) return ok('tunnel-token-1')
    if (request.method === 'GET') return ok([])
    return ok({})
  },
})
const folder = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
afterAll(() => {
  cloudflare.stop(true)
  rmSync(folder, { recursive: true, force: true })
})
const runSetup = (extra: string[], processEnvironment = {}) =>
  setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', folder, '--version', '1.2.0', ...extra]), {
    cloudflareApiUrl: cloudflare.url.origin,
    processEnvironment,
  })
const environment = () => parseEnvironment(readFileSync(join(folder, '.env'), 'utf8'))

test('an unattended setup creates the tunnel and writes the Compose file, the gateway config and a private .env', async () => {
  await runSetup(['--hostname', 'Spyria.Example.com', '--join-by', 'invited-address'], {
    CLOUDFLARE_API_TOKEN: 'api-token',
  })
  expect(tunnelNames).toEqual(['spyria-spyria.example.com'])
  expect(readFileSync(join(folder, 'compose.yml'), 'utf8')).toContain('spyria-server:${SPYRIA_VERSION')
  expect(JSON.parse(readFileSync(join(folder, 'bifrost.json'), 'utf8'))).toMatchObject({
    encryption_key: 'env.BIFROST_ENCRYPTION_KEY',
  })
  expect(statSync(join(folder, '.env')).mode & 0o777).toBe(0o600)
  expect(environment()).toMatchObject({
    SPYRIA_DEPLOYMENT: 'spyria',
    SPYRIA_VERSION: '1.2.0',
    SPYRIA_APP_ORIGIN: 'https://spyria.example.com',
    SPYRIA_JOIN_BY: 'invited-address',
    CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
    COMPOSE_PROFILES: 'host,cloudflare',
  })
  expect(readFileSync(join(folder, '.env'), 'utf8')).not.toContain('api-token')
})

test('setting up again without a Cloudflare token keeps the tunnel and every secret', async () => {
  const before = environment()
  await runSetup(['--version', '1.3.0'])
  const after = environment()
  expect(after).toEqual({ ...before, SPYRIA_VERSION: '1.3.0' })
  expect(tunnelNames).toHaveLength(1)
})

test('setting up again keeps a deployment without a runtime host that way until --host turns it back on', async () => {
  await runSetup(['--no-host'])
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBeUndefined()
  await runSetup([])
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBeUndefined()
  await runSetup(['--host'])
  expect(environment().COMPOSE_PROFILES).toBe('host,cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toStartWith('http://server:3000/h/')
})

test('run from inside an install without --folder, setup keeps that install and its secrets rather than writing another install', async () => {
  const before = environment()
  const originalDirectory = process.cwd()
  try {
    process.chdir(folder)
    await setup(parseFlags(['setup', '--unattended', '--no-start']), {
      cloudflareApiUrl: cloudflare.url.origin,
      processEnvironment: {},
    })
    expect(environment()).toEqual(before)
  } finally {
    process.chdir(originalDirectory)
  }
})

test('an unattended setup refuses what it cannot decide: no hostname, a new hostname without a token, a malformed client id', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    const attempt = (extra: string[], processEnvironment = {}) =>
      setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0', ...extra]), {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment,
      }).catch((error: Error) => error.message)
    expect(await attempt([])).toBe('--hostname is required')
    expect(await attempt(['--hostname', 'spyria.example.com'])).toBe(
      'A Cloudflare API token is required to create the tunnel',
    )
    expect(
      await attempt(['--hostname', 'spyria.example.com', '--google-client-id', 'not-google'], {
        CLOUDFLARE_API_TOKEN: 't',
      }),
    ).toBe('not-google is not a Google OAuth client id')
    expect(
      await attempt(
        ['--hostname', 'spyria.example.com', '--join-by', 'invited-address', '--provider', 'cloudflare-access'],
        {
          CLOUDFLARE_API_TOKEN: 't',
        },
      ),
    ).toBe('--provider must be microsoft or okta or google or other or skip')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
