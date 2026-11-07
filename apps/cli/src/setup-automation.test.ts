import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseEnvironment } from './environment.ts'
import { parseFlags } from './flags.ts'
import { setup } from './setup.ts'

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
    if (pathname.endsWith('/email/routing/addresses') && request.method === 'POST')
      return ok({ email: 'pat@gmail.com', verified: null })
    return ok(request.method === 'GET' ? [] : {})
  },
})
const resend = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/domains' && request.method === 'GET') return Response.json({ data: [] })
    if (pathname === '/api-keys' && request.method === 'GET') return Response.json({ data: [] })
    if (pathname === '/api-keys') return Response.json({ id: 'key-1', token: 're_sending' })
    return Response.json({ id: 'domain-1', name: 'example.com', status: 'verified', records: [] })
  },
})
const folder = mkdtempSync(join(tmpdir(), 'spyria-setup-automation-'))
afterAll(() => {
  cloudflare.stop(true)
  resend.stop(true)
  rmSync(folder, { recursive: true, force: true })
})

test('setup with Cloudflare Access and Resend prints the provider values once, and stores only the sending key and the tunnel token', async () => {
  const printed: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    await setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', folder, '--version', '1.2.0'],
        ...['--hostname', 'spyria.example.com', '--cloudflare-token', 'cloudflare-api-token'],
        ...['--provider', 'cloudflare-access', '--owner-email', 'pat@gmail.com', '--resend-key', 're_full_access'],
      ]),
      { cloudflareApiUrl: cloudflare.url.origin, resendApiUrl: resend.url.origin },
    )
  } finally {
    log.mockRestore()
  }
  const output = printed.join('\n')
  expect(output).toContain('In Create a workspace, choose Other OIDC and enter:')
  expect(output).toContain('Email domain: example.com')
  expect(output).toContain('Issuer: https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/access-client')
  expect(output).toContain('Client secret: access-secret')
  expect(output).toContain('Then sign in as admin@example.com')
  const stored = readFileSync(join(folder, '.env'), 'utf8')
  expect(parseEnvironment(stored)).toMatchObject({
    SPYRIA_SMTP_URL: 'smtps://resend:re_sending@smtp.resend.com:465',
    SPYRIA_MAIL_FROM: 'Spyria <spyria@example.com>',
    CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
  })
  for (const secret of ['access-secret', 're_full_access', 'cloudflare-api-token']) expect(stored).not.toContain(secret)
})
