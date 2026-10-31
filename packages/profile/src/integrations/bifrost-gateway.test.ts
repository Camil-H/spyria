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
    expect(
      gateway.setUpToolServer({ name: 'docs', url: 'http://docs.test/mcp' }, async () => {}),
    ).rejects.toMatchObject(timedOut),
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
  [
    'meta',
    {
      provider: 'meta',
      keys: [],
      network_config: { base_url: 'https://api.meta.ai/v1' },
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
  'the first %s key creates its provider on the gateway, Z.ai and Meta as OpenAI-compatible custom providers',
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

test('the tool server list is read once per short window, and again after a server is set up or the window ends', async () => {
  const listings: number[] = []
  const toolServerListMilliseconds = 200
  const clientServer = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url)
      if (pathname === '/api/mcp/clients') listings.push(Date.now())
      return Response.json(pathname === '/api/mcp/clients' ? { clients: [] } : {})
    },
  })
  const listingGateway = createLlmGateway({
    url: `http://localhost:${clientServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
    toolServerListMilliseconds,
  })
  try {
    await Promise.all([listingGateway.toolServers(), listingGateway.toolServers()])
    await listingGateway.toolServers()
    expect(listings).toHaveLength(1)
    await listingGateway.setUpToolServer({ name: 'docs', url: 'http://docs.test/mcp', isShared: true })
    expect(listings).toHaveLength(2)
    await listingGateway.toolServers()
    expect(listings).toHaveLength(3)
    await listingGateway.toolServers()
    expect(listings).toHaveLength(3)
    await Bun.sleep(toolServerListMilliseconds + 50)
    await listingGateway.toolServers()
    expect(listings).toHaveLength(4)
  } finally {
    clientServer.stop(true)
  }
})

test('an admin read answering 503 once is retried; a 400 and a failing creation are not', async () => {
  const requests: string[] = []
  const flakyServer = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url)
      requests.push(`${request.method} ${pathname}`)
      if (pathname === '/api/governance/virtual-keys/refused') return new Response('', { status: 400 })
      if (request.method === 'POST') return new Response('', { status: 503 })
      const isFirst = requests.filter((sent) => sent === `GET ${pathname}`).length === 1
      return isFirst
        ? new Response('', { status: 503 })
        : Response.json({ virtual_key: { id: 'flaky', value: 'sk-bf-flaky' } })
    },
  })
  const flakyGateway = createLlmGateway({
    url: `http://localhost:${flakyServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
  })
  try {
    expect(await flakyGateway.virtualKeyValue('flaky')).toBe('sk-bf-flaky')
    await expect(flakyGateway.virtualKeyValue('refused')).rejects.toThrow('with 400')
    await expect(flakyGateway.saveVirtualKey({ id: undefined, keys: [] })).rejects.toThrow('with 503')
    expect(requests).toEqual([
      'GET /api/governance/virtual-keys/flaky',
      'GET /api/governance/virtual-keys/flaky',
      'GET /api/governance/virtual-keys/refused',
      'POST /api/governance/virtual-keys',
    ])
  } finally {
    flakyServer.stop(true)
  }
})

test('a consent starts on a read-only tool of the server, or on its first tool when it marks none read-only', async () => {
  const calledTools: string[] = []
  const flowId = crypto.randomUUID()
  const consentServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, origin } = new URL(request.url)
      if (pathname === '/api/governance/virtual-keys/key-1')
        return Response.json({ virtual_key: { id: 'key-1', value: 'sk-bf-1' } })
      if (pathname === `/api/oauth/per-user/flows/${flowId}/start`)
        return Response.json({ authorize_url: `${origin}/authorize` })
      const { method, params } = (await request.json()) as { method: string; params?: { name: string } }
      if (method === 'tools/list')
        return Response.json({
          result: {
            tools: [
              { name: 'docs-delete_page', annotations: { readOnlyHint: false } },
              { name: 'docs-create_page' },
              { name: 'docs-get_me', annotations: { readOnlyHint: true } },
              { name: 'wiki-update', annotations: { readOnlyHint: false } },
            ],
          },
        })
      calledTools.push(String(params?.name))
      return new Response(`Authentication required: ${origin}/auth?flow=${flowId}`)
    },
  })
  const consentGateway = createLlmGateway({
    url: `http://localhost:${consentServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
  })
  try {
    const docs = { id: 'docs', name: 'docs', tools: ['delete_page', 'create_page', 'get_me'], isPersonal: true }
    expect(await consentGateway.startToolConsent('key-1', docs)).toBe(
      `http://localhost:${consentServer.port}/authorize`,
    )
    const wiki = { id: 'wiki', name: 'wiki', tools: ['update'], isPersonal: true }
    expect(await consentGateway.startToolConsent('key-1', wiki)).toBe(
      `http://localhost:${consentServer.port}/authorize`,
    )
    expect(calledTools).toEqual(['docs-get_me', 'wiki-update'])
  } finally {
    consentServer.stop(true)
  }
})

test('a session is checked with a read-only tool only, and reads unauthorized when the provider refuses its token', async () => {
  const calledTools: string[] = []
  let answer = '{"result":{"content":[{"type":"text","text":"you are alice"}]}}'
  const checkServer = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (new URL(request.url).pathname === '/api/governance/virtual-keys/key-1')
        return Response.json({ virtual_key: { id: 'key-1', value: 'sk-bf-1' } })
      const { method, params } = (await request.json()) as { method: string; params?: { name: string } }
      if (method === 'tools/list')
        return Response.json({
          result: {
            tools: [
              { name: 'docs-delete_page', annotations: { readOnlyHint: false } },
              { name: 'docs-get_me', annotations: { readOnlyHint: true } },
              { name: 'wiki-update' },
            ],
          },
        })
      calledTools.push(String(params?.name))
      return new Response(answer)
    },
  })
  const checkGateway = createLlmGateway({
    url: `http://localhost:${checkServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
  })
  try {
    const docs = { id: 'docs', name: 'docs', tools: ['delete_page', 'get_me'], isPersonal: true }
    expect(await checkGateway.isToolSessionAuthorized('key-1', docs)).toBe(true)
    answer =
      '{"result":{"isError":true,"content":[{"type":"text","text":"Tool execution failed: failed to establish ephemeral MCP connection: transport error: request failed with status 401: invalid_token"}]}}'
    expect(await checkGateway.isToolSessionAuthorized('key-1', docs)).toBe(false)
    const wiki = { id: 'wiki', name: 'wiki', tools: ['update'], isPersonal: true }
    expect(await checkGateway.isToolSessionAuthorized('key-1', wiki)).toBeUndefined()
    expect(calledTools).toEqual(['docs-get_me', 'docs-get_me'])
  } finally {
    checkServer.stop(true)
  }
})

test('a tool server with a per-member sign-in is not set up without an operator login', async () => {
  const setUpServer = Bun.serve({ port: 0, fetch: () => Response.json({ clients: [] }) })
  const setUpGateway = createLlmGateway({
    url: `http://localhost:${setUpServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
  })
  try {
    expect(
      (await setUpGateway.setUpToolServer({ name: 'docs', url: 'http://docs.test/mcp' }).catch((error) => error))
        .message,
    ).toBe('Setting up docs needs an operator to log in to it')
  } finally {
    setUpServer.stop(true)
  }
})

test('the sessions of a tool are its credentials: a pending sign-in, which lets no call run, is left out', async () => {
  const sessionServer = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        sessions: [
          { id: 'flow-1', kind: 'flow', status: 'pending' },
          { id: 'token-1', kind: 'token', status: 'active' },
          { id: 'header-1', kind: 'header', status: 'active' },
        ],
      }),
  })
  const sessionGateway = createLlmGateway({
    url: `http://localhost:${sessionServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
  })
  try {
    const docs = { id: 'docs', name: 'docs', tools: ['search'], isPersonal: true }
    expect((await sessionGateway.toolSessions('key-1', docs)).map(({ id }) => id)).toEqual(['token-1', 'header-1'])
  } finally {
    sessionServer.stop(true)
  }
})

test('a virtual key value rotated outside Spyria is read again once its cached value expires', async () => {
  let value = 'sk-bf-before'
  const rotatingServer = Bun.serve({
    port: 0,
    fetch: () => Response.json({ virtual_key: { id: 'rotating', value } }),
  })
  const rotatingGateway = createLlmGateway({
    url: `http://localhost:${rotatingServer.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
    virtualKeyMilliseconds: 50,
  })
  try {
    expect(await rotatingGateway.virtualKeyValue('rotating')).toBe('sk-bf-before')
    value = 'sk-bf-after'
    expect(await rotatingGateway.virtualKeyValue('rotating')).toBe('sk-bf-before')
    await Bun.sleep(60)
    expect(await rotatingGateway.virtualKeyValue('rotating')).toBe('sk-bf-after')
  } finally {
    rotatingServer.stop(true)
  }
})
