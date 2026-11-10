import { afterAll, expect, test } from 'bun:test'
import { cloudflareClientOf } from './cloudflare.ts'
import { setUpResend } from './resend.ts'

const dnsRecords: { type: string; name: string; content: string; priority?: number }[] = [
  { type: 'TXT', name: 'resend._domainkey.example.com', content: '"p=KEY"' },
]
let statusChecks = 0
const apiKeys: unknown[] = []
const deletedKeys: string[] = []
const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const cloudflare = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/zones') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }])
    if (url.pathname === '/zones/zone-1/dns_records' && request.method === 'GET')
      return ok(
        dnsRecords.filter(
          ({ name, type }) => name === url.searchParams.get('name') && type === url.searchParams.get('type'),
        ),
      )
    dnsRecords.push((await request.json()) as never)
    return ok({})
  },
})
const resend = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (request.headers.get('authorization') !== 'Bearer re_full')
      return Response.json({ message: 'API key is invalid' }, { status: 401 })
    if (pathname === '/domains' && request.method === 'GET') return Response.json({ data: [] })
    if (pathname === '/domains') return Response.json({ id: 'domain-1', name: 'example.com', status: 'not_started' })
    if (pathname === '/domains/domain-1/verify') return Response.json({ object: 'domain', id: 'domain-1' })
    if (pathname === '/domains/domain-1')
      return Response.json({
        id: 'domain-1',
        name: 'example.com',
        status: statusChecks++ > 1 ? 'verified' : 'pending',
        records: [
          { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
          { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.com ~all' },
          { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=KEY' },
        ],
      })
    if (pathname === '/api-keys' && request.method === 'GET')
      return Response.json({
        data: [
          { id: 'old-key', name: 'Spyria on spyria.example.com' },
          { id: 'key-1', name: 'Spyria on spyria.example.com' },
          { id: 'other', name: 'Other' },
        ],
      })
    if (pathname === '/api-keys/old-key' && request.method === 'DELETE') {
      deletedKeys.push('old-key')
      return Response.json({})
    }
    if (pathname === '/api-keys') {
      apiKeys.push(await request.json())
      return Response.json({ id: 'key-1', token: 're_sending' })
    }
    return Response.json({ message: 'not found' }, { status: 404 })
  },
})
afterAll(() => {
  cloudflare.stop(true)
  resend.stop(true)
})

test('Resend gets the domain, its DNS records land in the Cloudflare zone once, SMTP uses a new sending-only key, and the key it replaces is revoked only when setup asks, once the new one is in use', async () => {
  const mail = await setUpResend({
    apiKey: 're_full',
    hostname: 'spyria.example.com',
    cloudflare: cloudflareClientOf('token', cloudflare.url.origin),
    api: resend.url.origin,
    pollMilliseconds: 1,
  })
  const { retireReplacedKeys } = mail
  expect(mail).toEqual({
    smtpUrl: 'smtps://resend:re_sending@smtp.resend.com:465',
    mailFrom: 'Spyria <spyria@example.com>',
    retireReplacedKeys: expect.any(Function),
  })
  expect(dnsRecords).toEqual([
    { type: 'TXT', name: 'resend._domainkey.example.com', content: '"p=KEY"' },
    { type: 'MX', name: 'send.example.com', content: 'feedback-smtp.us-east-1.amazonses.com', ttl: 1, priority: 10 },
    { type: 'TXT', name: 'send.example.com', content: 'v=spf1 include:amazonses.com ~all', ttl: 1 },
  ] as never)
  expect(apiKeys).toEqual([
    { name: 'Spyria on spyria.example.com', permission: 'sending_access', domain_id: 'domain-1' },
  ])
  expect(deletedKeys).toEqual([])
  await retireReplacedKeys()
  expect(deletedKeys).toEqual(['old-key'])
  expect(JSON.stringify(mail)).not.toContain('re_full')
})

test("a refused Resend key fails with Resend's reason", async () => {
  expect(
    await setUpResend({
      apiKey: 're_wrong',
      hostname: 'spyria.example.com',
      cloudflare: cloudflareClientOf('token', cloudflare.url.origin),
      api: resend.url.origin,
    }).catch((error: Error) => error.message),
  ).toBe('Resend refused GET /domains: API key is invalid')
})
