import { afterAll, expect, test } from 'bun:test'
import { cloudflareClientOf } from './cloudflare.ts'
import { createAccessOidcApp, routeAdminMail } from './cloudflare-access.ts'

const posted: { path: string; body: unknown }[] = []
const rules: { matchers: { type: string; field: string; value: string }[] }[] = []
const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const fake = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.json()
    if (request.method !== 'GET') posted.push({ path: pathname, body })
    if (pathname === '/zones') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }])
    if (pathname === '/accounts/account-1/access/organizations') return ok({ auth_domain: 'team.cloudflareaccess.com' })
    if (pathname === '/accounts/account-1/access/identity_providers')
      return request.method === 'GET'
        ? ok([{ id: 'github-1', type: 'github' }])
        : ok({ id: 'pin-1', type: 'onetimepin' })
    if (pathname === '/accounts/account-1/access/policies') return ok({ id: 'policy-1' })
    if (pathname === '/accounts/account-1/access/apps')
      return ok({ id: 'app-1', saas_app: { client_id: 'client-1', client_secret: 'secret-1' } })
    if (pathname === '/zones/zone-1/email/routing/enable') return ok({})
    if (pathname === '/accounts/account-1/email/routing/addresses')
      return request.method === 'GET' ? ok([]) : ok({ email: 'pat@gmail.com', verified: null })
    if (pathname === '/zones/zone-1/email/routing/rules') {
      if (request.method === 'GET') return ok(rules)
      rules.push(body as never)
      return ok(body)
    }
    return Response.json({ success: false, errors: [{ message: `no ${pathname}` }] }, { status: 404 })
  },
})
afterAll(() => fake.stop(true))
const call = cloudflareClientOf('token', fake.url.origin)

test('an Access SaaS app signs people at the domain and the owner in with a one-time PIN, through OIDC with PKCE', async () => {
  const provider = await createAccessOidcApp(call, {
    hostname: 'spyria.example.com',
    origin: 'https://spyria.example.com',
    ownerEmail: 'pat@gmail.com',
    name: 'Spyria',
  })
  expect(provider).toEqual({
    issuer: 'https://team.cloudflareaccess.com/cdn-cgi/access/sso/oidc/client-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
  })
  expect(posted.find(({ path }) => path.endsWith('/identity_providers'))?.body).toEqual({
    type: 'onetimepin',
    name: 'One-time PIN',
    config: {},
  })
  expect(posted.find(({ path }) => path.endsWith('/policies'))?.body).toMatchObject({
    decision: 'allow',
    include: [{ email_domain: { domain: 'example.com' } }, { email: { email: 'pat@gmail.com' } }],
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

test("Email Routing forwards admin@ the domain to the owner once, who confirms the destination from Cloudflare's email", async () => {
  expect(await routeAdminMail(call, { hostname: 'spyria.example.com', ownerEmail: 'pat@gmail.com' })).toEqual({
    adminAddress: 'admin@example.com',
    awaitsConfirmation: true,
  })
  await routeAdminMail(call, { hostname: 'spyria.example.com', ownerEmail: 'pat@gmail.com' })
  expect(rules).toEqual([
    {
      name: 'admin@example.com to pat@gmail.com',
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: 'admin@example.com' }],
      actions: [{ type: 'forward', value: ['pat@gmail.com'] }],
    },
  ] as never)
})
