import { afterAll, expect, test } from 'bun:test'
import { registerOktaApp } from './okta.ts'

const requests: { method: string; path: string; body?: unknown }[] = []
const okta = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.json()
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
    if (request.headers.get('authorization') !== 'SSWS okta-token')
      return Response.json({ errorSummary: 'Invalid token provided' }, { status: 401 })
    if (url.pathname === '/api/v1/apps')
      return Response.json({
        id: 'app-1',
        credentials: { oauthClient: { client_id: 'client-1', client_secret: 'secret-1' } },
      })
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

test('Okta gets a web OIDC app with the redirect URI, assigned to Everyone, and the org is the issuer', async () => {
  expect(
    await registerOktaApp({
      orgUrl: `${okta.url.origin}/admin`,
      apiToken: 'okta-token',
      origin: 'https://spyria.example.com',
    }),
  ).toEqual({
    issuer: okta.url.origin,
    clientId: 'client-1',
    clientSecret: 'secret-1',
  })
  expect(requests[0]?.body).toMatchObject({
    signOnMode: 'OPENID_CONNECT',
    settings: {
      oauthClient: { redirect_uris: ['https://spyria.example.com/auth/callback'], grant_types: ['authorization_code'] },
    },
  })
  expect(requests.at(-1)).toMatchObject({ method: 'PUT', path: '/api/v1/apps/app-1/groups/everyone-1' })
})

test("a refused Okta token fails with Okta's reason", async () => {
  expect(
    await registerOktaApp({ orgUrl: okta.url.origin, apiToken: 'wrong', origin: 'https://spyria.example.com' }).catch(
      (error: Error) => error.message,
    ),
  ).toBe('Okta refused POST /api/v1/apps: Invalid token provided')
})
