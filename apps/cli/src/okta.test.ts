import { afterAll, beforeEach, expect, test } from 'bun:test'
import { registerOktaApp } from './okta.ts'

type FakeApp = {
  id: string
  label: string
  status: string
  credentials: { oauthClient: { client_id: string; client_secret?: string } }
}
const requests: { method: string; path: string; body?: unknown }[] = []
const apps: FakeApp[] = []
const assignments: string[] = []
const listed = (app: FakeApp) => ({
  ...app,
  credentials: { oauthClient: { client_id: app.credentials.oauthClient.client_id } },
})
const okta = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.json()
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
    if (request.headers.get('authorization') !== 'SSWS okta-token')
      return Response.json({ errorSummary: 'Invalid token provided' }, { status: 401 })
    if (url.pathname === '/api/v1/apps' && request.method === 'GET')
      return Response.json(
        apps
          .filter((app) => app.label.toLowerCase().startsWith((url.searchParams.get('q') ?? '').toLowerCase()))
          .map(listed),
      )
    if (url.pathname === '/api/v1/apps' && request.method === 'POST') {
      const number = apps.length + 1
      const app = {
        id: `app-${number}`,
        label: (body as { label: string }).label,
        status: 'ACTIVE',
        credentials: { oauthClient: { client_id: `client-${number}`, client_secret: `secret-${number}` } },
      }
      apps.push(app)
      return Response.json(app)
    }
    const secretsOf = url.pathname.match(/^\/api\/v1\/apps\/([\w-]+)\/credentials\/secrets$/)
    if (secretsOf && request.method === 'POST')
      return Response.json({ id: 'secret-id', status: 'ACTIVE', client_secret: `new-secret-of-${secretsOf[1]}` })
    const assignment = url.pathname.match(/^\/api\/v1\/apps\/([\w-]+)\/groups\/([\w-]+)$/)
    if (assignment && request.method === 'PUT') assignments.push(`${assignment[1]} ${assignment[2]}`)
    if (url.pathname === '/api/v1/groups')
      return Response.json(
        url.searchParams.get('search') === 'type eq "BUILT_IN"'
          ? [
              { id: 'admins-1', profile: { name: 'Okta Administrators' } },
              { id: 'everyone-1', profile: { name: 'Everyone' } },
            ]
          : [],
      )
    return Response.json({})
  },
})
afterAll(() => okta.stop(true))
beforeEach(() => {
  requests.length = 0
  apps.length = 0
  assignments.length = 0
})

const register = (origin = 'https://spyria.example.com') =>
  registerOktaApp({ orgUrl: `${okta.url.origin}/admin`, apiToken: 'okta-token', origin })

test('Okta gets a web OIDC app with the redirect URI, assigned to Everyone, and the org is the issuer', async () => {
  expect(await register()).toEqual({ issuer: okta.url.origin, clientId: 'client-1', clientSecret: 'secret-1' })
  expect(requests.find((request) => request.method === 'POST')?.body).toMatchObject({
    label: 'Spyria spyria.example.com',
    signOnMode: 'OPENID_CONNECT',
    settings: {
      oauthClient: { redirect_uris: ['https://spyria.example.com/auth/callback'], grant_types: ['authorization_code'] },
    },
  })
  expect(assignments).toEqual(['app-1 everyone-1'])
})

test('setting Okta up again reuses the app of the same label with a new secret, still assigned to Everyone, and ignores an inactive one or a longer label', async () => {
  apps.push(
    {
      id: 'app-inactive',
      label: 'Spyria spyria.example.com',
      status: 'INACTIVE',
      credentials: { oauthClient: { client_id: 'client-inactive' } },
    },
    {
      id: 'app-longer',
      label: 'Spyria spyria.example.com.au',
      status: 'ACTIVE',
      credentials: { oauthClient: { client_id: 'client-longer' } },
    },
  )
  const first = await register()
  const again = await register()
  expect(again).toEqual({ issuer: okta.url.origin, clientId: first.clientId, clientSecret: 'new-secret-of-app-3' })
  expect(apps.filter((app) => app.label === 'Spyria spyria.example.com' && app.status === 'ACTIVE')).toHaveLength(1)
  expect(requests.filter((request) => request.method === 'POST' && request.path === '/api/v1/apps')).toHaveLength(1)
  expect(assignments).toEqual(['app-3 everyone-1', 'app-3 everyone-1'])
})

test("a refused Okta token fails with Okta's reason", async () => {
  expect(
    await registerOktaApp({ orgUrl: okta.url.origin, apiToken: 'wrong', origin: 'https://spyria.example.com' }).catch(
      (error: Error) => error.message,
    ),
  ).toBe('Okta refused GET /api/v1/apps: Invalid token provided')
})

test('an Okta address over http is refused', async () => {
  expect(
    await registerOktaApp({
      orgUrl: 'http://acme.okta.com',
      apiToken: 'okta-token',
      origin: 'https://spyria.example.com',
    }).catch((error: Error) => error.message),
  ).toBe('The Okta organization URL must start with https://, so the API token never travels in clear')
})
