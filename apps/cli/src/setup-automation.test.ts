import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvironment } from './environment.ts'
import { parseFlags } from './flags.ts'
import { setup } from './setup.ts'

let refusesMailRouting = false
const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const cloudflare = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (request.method !== 'GET') await request.json()
    if (pathname === '/zones') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }])
    if (pathname.endsWith('/token')) return ok('tunnel-token-1')
    if (pathname === '/accounts/account-1/cfd_tunnel' && request.method === 'POST') return ok({ id: 'tunnel-1' })
    if (pathname === '/accounts/account-1/access/organizations') return ok({ auth_domain: 'team.cloudflareaccess.com' })
    if (pathname === '/accounts/account-1/access/apps' && request.method === 'POST')
      return ok({ id: 'app-1', saas_app: { client_id: 'access-client', client_secret: 'access-secret' } })
    if (pathname.endsWith('/policies') && request.method === 'POST') return ok({ id: 'policy-1', name: 'p' })
    if (pathname.endsWith('/identity_providers'))
      return ok(request.method === 'GET' ? [{ id: 'pin-1', type: 'onetimepin' }] : {})
    if (refusesMailRouting && pathname.endsWith('/email/routing/dns'))
      return Response.json({ success: false, errors: [{ message: 'Email Routing is unavailable' }], result: null })
    if (pathname.endsWith('/email/routing/addresses') && request.method === 'POST')
      return ok({ email: 'pat@gmail.com', verified: null })
    return ok(request.method === 'GET' ? [] : {})
  },
})
const folder = mkdtempSync(join(tmpdir(), 'spyria-setup-automation-'))
afterAll(() => {
  cloudflare.stop(true)
  rmSync(folder, { recursive: true, force: true })
})

test('setup with Cloudflare Access prints the provider values once and stores only the tunnel token', async () => {
  const printed: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    await setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', folder, '--version', '1.2.0'],
        ...['--hostname', 'spyria.example.com', '--provider', 'cloudflare-access', '--owner-email', 'pat@gmail.com'],
      ]),
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 'cloudflare-api-token' },
        dataVolumesOf: () => [],
      },
    )
  } finally {
    log.mockRestore()
  }
  const output = printed.join('\n')
  expect(output).toContain('In Create a workspace, choose Other OIDC and enter:')
  expect(output).toContain('Issuer: https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client')
  expect(output).toContain('Client secret: access-secret')
  expect(output).toContain('Then sign in as admin@example.com')
  const stored = readFileSync(join(folder, '.env'), 'utf8')
  expect(parseEnvironment(stored)).toMatchObject({ CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1' })
  for (const secret of ['access-secret', 'cloudflare-api-token']) expect(stored).not.toContain(secret)
})

test('setup shows the Access client secret even when routing the admin mail fails afterwards', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-automation-'))
  const printed: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...parts) => void printed.push(parts.join(' ')))
  refusesMailRouting = true
  try {
    const failure = await setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0'],
        ...['--hostname', 'spyria.example.com', '--provider', 'cloudflare-access', '--owner-email', 'pat@gmail.com'],
      ]),
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 'cloudflare-api-token' },
        dataVolumesOf: () => [],
      },
    ).catch((error: Error) => error.message)
    expect(failure).toBe('Cloudflare refused POST /zones/zone-1/email/routing/dns: Email Routing is unavailable')
  } finally {
    refusesMailRouting = false
    log.mockRestore()
    rmSync(install, { recursive: true, force: true })
  }
  expect(printed.join('\n')).toContain('Client secret: access-secret')
})
