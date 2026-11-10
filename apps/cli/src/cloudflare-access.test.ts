import { afterAll, beforeEach, expect, test } from 'bun:test'
import { cloudflareClientOf } from './cloudflare.ts'
import { createAccessOidcApp, routeAdminMail } from './cloudflare-access.ts'

const posted: { path: string; body: unknown }[] = []
const state = {
  apps: [] as { id: string; name: string }[],
  policies: [] as { id: string; name: string }[],
  mailServers: [] as { content: string }[],
  rules: [] as { matchers: { type: string; field: string; value: string }[]; actions: { value: string[] }[] }[],
}
const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const fake = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const isRead = request.method === 'GET'
    const body = isRead ? undefined : await request.json()
    if (!isRead) posted.push({ path: pathname, body })
    if (pathname === '/zones') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }])
    if (pathname === '/accounts/account-1/access/organizations') return ok({ auth_domain: 'team.cloudflareaccess.com' })
    if (pathname === '/accounts/account-1/access/identity_providers')
      return isRead ? ok([{ id: 'github-1', type: 'github' }]) : ok({ id: 'pin-1', type: 'onetimepin' })
    if (pathname === '/accounts/account-1/access/policies') {
      if (isRead) return ok(state.policies)
      const policy = { id: `policy-${state.policies.length + 1}`, name: (body as { name: string }).name }
      state.policies.push(policy)
      return ok(policy)
    }
    if (pathname === '/accounts/account-1/access/apps') {
      if (isRead) return ok(state.apps)
      state.apps.push({ id: 'app-1', name: (body as { name: string }).name })
      return ok({ id: 'app-1', saas_app: { client_id: 'client-1', client_secret: 'secret-1' } })
    }
    if (pathname === '/zones/zone-1/dns_records') return ok(state.mailServers)
    if (pathname === '/zones/zone-1/email/routing/dns') return ok({})
    if (pathname === '/accounts/account-1/email/routing/addresses')
      return isRead ? ok([]) : ok({ email: 'pat@gmail.com', verified: null })
    if (pathname === '/zones/zone-1/email/routing/rules') {
      if (isRead) return ok(state.rules)
      state.rules.push(body as never)
      return ok(body)
    }
    return Response.json({ success: false, errors: [{ message: `no ${pathname}` }] }, { status: 404 })
  },
})
afterAll(() => fake.stop(true))
beforeEach(() => {
  posted.length = 0
})
const call = cloudflareClientOf('token', fake.url.origin)
const appSettings = { hostname: 'spyria.example.com', origin: 'https://spyria.example.com', name: 'Spyria' }

test('an Access SaaS app signs people at the domain in with a one-time PIN, through OIDC with PKCE', async () => {
  expect(await createAccessOidcApp(call, appSettings)).toEqual({
    issuer: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    domain: 'example.com',
  })
  expect(posted.find(({ path }) => path.endsWith('/identity_providers'))?.body).toEqual({
    type: 'onetimepin',
    name: 'One-time PIN',
    config: {},
  })
  expect(posted.find(({ path }) => path.endsWith('/policies'))?.body).toEqual({
    name: 'Spyria: people at example.com',
    decision: 'allow',
    include: [{ email_domain: { domain: 'example.com' } }],
  })
  expect(posted.find(({ path }) => path.endsWith('/apps'))?.body).toMatchObject({
    type: 'saas',
    allowed_idps: ['pin-1'],
    policies: [{ id: 'policy-1', precedence: 1 }],
    saas_app: {
      auth_type: 'oidc',
      redirect_uris: ['https://spyria.example.com/auth/callback'],
      grant_types: ['authorization_code_with_pkce'],
    },
  })
})

test('a second run refuses to duplicate the Access app, whose secret cannot be read back, and reuses the policy', async () => {
  expect(await createAccessOidcApp(call, appSettings).catch((error: Error) => error.message)).toContain(
    'An Access application named Spyria exists already',
  )
  state.apps.length = 0
  await createAccessOidcApp(call, appSettings)
  expect(state.policies).toHaveLength(1)
})

test("Email Routing forwards admin@ the domain to the owner once, who confirms the destination from Cloudflare's email", async () => {
  expect(await routeAdminMail(call, { hostname: 'spyria.example.com', ownerEmail: 'pat@gmail.com' })).toEqual({
    adminAddress: 'admin@example.com',
    outcome: 'awaits_confirmation',
  })
  await routeAdminMail(call, { hostname: 'spyria.example.com', ownerEmail: 'pat@gmail.com' })
  expect(state.rules).toEqual([
    {
      name: 'admin@example.com to pat@gmail.com',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'admin@example.com' }],
      actions: [{ type: 'forward', value: ['pat@gmail.com'] }],
    },
  ] as never)
  expect(await routeAdminMail(call, { hostname: 'spyria.example.com', ownerEmail: 'sam@gmail.com' })).toMatchObject({
    outcome: 'routed_elsewhere',
  })
})

test('a domain that already receives mail elsewhere keeps its mail servers: Email Routing is left off', async () => {
  state.mailServers = [{ content: 'aspmx.l.google.com' }]
  posted.length = 0
  expect(await routeAdminMail(call, { hostname: 'spyria.example.com', ownerEmail: 'pat@gmail.com' })).toEqual({
    adminAddress: 'admin@example.com',
    outcome: 'has_mailboxes',
  })
  expect(posted).toEqual([])
})
