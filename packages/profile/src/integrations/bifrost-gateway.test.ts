import { afterAll, expect, test } from 'bun:test'
import { createLlmGateway } from './bifrost-gateway.ts'

const answered: Record<string, object> = {
  '/api/mcp/clients': { clients: [] },
  '/api/governance/virtual-keys/key-1': { virtual_key: { id: 'key-1', value: 'sk-bf-1' } },
}
const gatewayServer = Bun.serve({
  port: 0,
  fetch: (request) => {
    const { pathname, origin } = new URL(request.url)
    if (pathname === '/api/mcp/client') return Response.json({ authorize_url: `${origin}/authorize` })
    return answered[pathname] ? Response.json(answered[pathname]) : new Promise<Response>(() => {})
  },
})
afterAll(() => gatewayServer.stop(true))
const gateway = createLlmGateway({
  url: `http://localhost:${gatewayServer.port}`,
  adminUser: 'admin',
  adminPassword: 'secret',
  timeoutMilliseconds: 100,
})
const timedOut = { name: 'TimeoutError' }

test('admin requests, the OAuth fetches and the consent call give up after the timeout', async () => {
  const startedAt = Date.now()
  await Promise.all([
    expect(gateway.removeToolSession('session-1')).rejects.toMatchObject(timedOut),
    expect(gateway.finishToolConsent('?state=1')).rejects.toMatchObject(timedOut),
    expect(gateway.setUpToolServer({ name: 'docs', url: 'http://docs.test/mcp' })).rejects.toMatchObject(timedOut),
    expect(gateway.startToolConsent('key-1', { id: 'docs', name: 'docs', tools: ['search'] })).rejects.toMatchObject(
      timedOut,
    ),
  ])
  expect(Date.now() - startedAt).toBeLessThan(2_000)
})
