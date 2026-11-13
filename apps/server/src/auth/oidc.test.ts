import { afterAll, expect, test } from 'bun:test'
import { discoverIssuer } from './oidc.ts'

let discoveryRequests = 0
const server = Bun.serve({
  port: 0,
  fetch: async (request): Promise<Response> => {
    discoveryRequests++
    await Bun.sleep(5)
    const issuer = new URL(request.url).origin
    return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, jwks_uri: `${issuer}/keys` })
  },
})
const issuer = server.url.origin
afterAll(() => server.stop(true))

test('concurrent discoveries of one issuer share a single request to its discovery document', async () => {
  const [first, second] = await Promise.all([discoverIssuer(issuer), discoverIssuer(issuer)])
  expect(first.authorization_endpoint).toBe(`${issuer}/authorize`)
  expect(second).toBe(first)
  expect(discoveryRequests).toBe(1)
  await discoverIssuer(issuer)
  expect(discoveryRequests).toBe(2)
})
