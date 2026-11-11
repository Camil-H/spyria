import { afterAll, expect, test } from 'bun:test'
import { createTunnel } from './cloudflare.ts'

type Call = { method: string; path: string; body?: unknown }
const calls: Call[] = []
const tunnels: { id: string; name: string }[] = []
const records: { id: string; type?: string; name: string; content: string }[] = []
const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const fake = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    const body = request.method === 'GET' ? undefined : await request.json()
    calls.push({ method: request.method, path: `${url.pathname}${url.search}`, body })
    if (request.headers.get('authorization') !== 'Bearer good-token')
      return Response.json({ success: false, errors: [{ message: 'Invalid API token' }] }, { status: 403 })
    if (url.pathname === '/zones')
      return ok(
        url.searchParams.get('name') === 'example.com'
          ? [{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }]
          : [],
      )
    if (url.pathname === '/accounts/account-1/cfd_tunnel' && request.method === 'GET')
      return ok(tunnels.filter((tunnel) => tunnel.name === url.searchParams.get('name')))
    if (url.pathname === '/accounts/account-1/cfd_tunnel') {
      const tunnel = { id: `tunnel-${tunnels.length + 1}`, name: (body as { name: string }).name }
      tunnels.push(tunnel)
      return ok(tunnel)
    }
    if (/^\/accounts\/account-1\/cfd_tunnel\/[\w-]+\/configurations$/.test(url.pathname)) return ok({})
    if (/^\/accounts\/account-1\/cfd_tunnel\/[\w-]+\/token$/.test(url.pathname))
      return ok(`token-of-${url.pathname.split('/')[4]}`)
    if (url.pathname === '/zones/zone-1/dns_records' && request.method === 'GET')
      return ok(records.filter((record) => record.name === url.searchParams.get('name')))
    if (url.pathname === '/zones/zone-1/dns_records') {
      const record = { id: `record-${records.length + 1}`, ...(body as { name: string; content: string }) }
      records.push(record)
      return ok(record)
    }
    if (url.pathname.startsWith('/zones/zone-1/dns_records/')) return ok(body)
    return Response.json({ success: false, errors: [{ message: 'not found' }] }, { status: 404 })
  },
})
afterAll(() => fake.stop(true))
const api = fake.url.origin

test('a tunnel is created for the hostname in its zone, routes it to the server alone, gets a CNAME and hands back its token', async () => {
  const created = await createTunnel({
    apiToken: 'good-token',
    hostname: 'spyria.team.example.com',
    tunnelName: 'spyria',
    api,
  })
  expect(created).toEqual({
    tunnelId: 'tunnel-1',
    token: 'token-of-tunnel-1',
    origin: 'https://spyria.team.example.com',
  })
  expect(calls.filter(({ path }) => path.startsWith('/zones?')).map(({ path }) => path)).toEqual([
    '/zones?name=spyria.team.example.com',
    '/zones?name=team.example.com',
    '/zones?name=example.com',
  ])
  expect(calls.find(({ path }) => path.endsWith('/configurations'))?.body).toEqual({
    config: {
      ingress: [{ hostname: 'spyria.team.example.com', service: 'http://server:3000' }, { service: 'http_status:404' }],
    },
  })
  expect(records).toEqual([
    {
      id: 'record-1',
      type: 'CNAME',
      name: 'spyria.team.example.com',
      content: 'tunnel-1.cfargotunnel.com',
      proxied: true,
    },
  ] as never)
})

test('setting up again reuses the tunnel and updates the DNS record instead of adding one', async () => {
  calls.length = 0
  const again = await createTunnel({
    apiToken: 'good-token',
    hostname: 'spyria.team.example.com',
    tunnelName: 'spyria',
    api,
  })
  expect(again.tunnelId).toBe('tunnel-1')
  expect(tunnels).toHaveLength(1)
  expect(records).toHaveLength(1)
  expect(calls.some(({ method, path }) => method === 'PUT' && path === '/zones/zone-1/dns_records/record-1')).toBe(true)
})

test('a hostname already holding other DNS records is refused with their types, before any tunnel or record changes', async () => {
  records.push(
    { id: 'record-a', type: 'A', name: 'www.example.com', content: '203.0.113.7' },
    { id: 'record-aaaa', type: 'AAAA', name: 'www.example.com', content: '2001:db8::7' },
  )
  calls.length = 0
  const refusal = await createTunnel({
    apiToken: 'good-token',
    hostname: 'www.example.com',
    tunnelName: 'www',
    api,
  }).catch((error: Error) => error.message)
  expect(refusal).toBe(
    'www.example.com already has DNS records (A, AAAA): delete them in Cloudflare, or choose another hostname',
  )
  expect(calls.filter(({ method }) => method !== 'GET')).toEqual([])
  expect(tunnels).toHaveLength(1)
})

test("a hostname outside the token's zones and a refused token fail with Cloudflare's reason", async () => {
  expect(
    await createTunnel({ apiToken: 'good-token', hostname: 'spyria.other.org', tunnelName: 'spyria', api }).catch(
      (error: Error) => error.message,
    ),
  ).toBe('No Cloudflare zone this token can edit holds spyria.other.org')
  expect(
    await createTunnel({ apiToken: 'bad-token', hostname: 'spyria.example.com', tunnelName: 'spyria', api }).catch(
      (error: Error) => error.message,
    ),
  ).toBe('Cloudflare refused GET /zones: Invalid API token')
})
