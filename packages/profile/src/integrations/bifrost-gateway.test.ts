import { afterAll, expect, test } from 'bun:test'
import { Secret } from '../domain/secret.ts'
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
    expect(
      gateway.startToolConsent('key-1', { id: 'docs', name: 'docs', tools: ['search'], isPersonal: true }),
    ).rejects.toMatchObject(timedOut),
  ])
  expect(Date.now() - startedAt).toBeLessThan(2_000)
})

test.each([
  ['openrouter', { provider: 'openrouter', keys: [] }],
  [
    'zai',
    {
      provider: 'zai',
      keys: [],
      network_config: { base_url: 'https://api.z.ai/api/paas/v4' },
      custom_provider_config: {
        base_provider_type: 'openai',
        request_path_overrides: {
          chat_completion: '/chat/completions',
          chat_completion_stream: '/chat/completions',
          list_models: '/models',
        },
      },
    },
  ],
])(
  'the first %s key creates its provider on the gateway, Z.ai as an OpenAI-compatible custom provider',
  async (provider, created) => {
    const createdProviders: object[] = []
    const providerServer = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const { pathname } = new URL(request.url)
        if (pathname === '/api/providers') createdProviders.push(await request.json())
        if (pathname.endsWith('/keys') && createdProviders.length === 0) return new Response('', { status: 404 })
        return Response.json(pathname.endsWith('/keys') ? { id: 'key-1' } : { models: [] })
      },
    })
    const providerGateway = createLlmGateway({
      url: `http://localhost:${providerServer.port}`,
      adminUser: 'admin',
      adminPassword: 'secret',
    })
    try {
      expect(await providerGateway.addProviderKey({ provider, name: 'cred_1', secret: new Secret('sk-1234') })).toEqual(
        {
          provider,
          id: 'key-1',
        },
      )
      expect(createdProviders).toEqual([created])
    } finally {
      providerServer.stop(true)
    }
  },
)
