import { afterAll, expect, test } from 'bun:test'
import { connect } from 'node:net'
import {
  connectTargetOf,
  createPolicyProxy,
  isInternalAddress,
  networkVerdictOf,
  siteVerdictOf,
} from './network-policy.mjs'

const settings = {
  blockInternalNetworks: true,
  allowedInternalAddresses: [],
  allowedSites: [],
  blockedSites: [],
}

test('private, link-local, shared and reserved addresses are internal, in every IPv6 spelling', () => {
  for (const address of [
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '::ffff:a00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:c0a8:101::1',
  ])
    expect(isInternalAddress(address)).toBe(true)
  for (const address of ['93.184.216.34', '192.0.2.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8'])
    expect(isInternalAddress(address)).toBe(false)
})

test('loopback reaches the runtime the browser shares its network with', () => {
  expect(networkVerdictOf(settings, 'localhost', ['::1'])).toBe('allowed')
  expect(networkVerdictOf(settings, 'localhost', ['127.0.0.1'])).toBe('allowed')
})

test('internal networks are blocked unless the admin turned the block off or named the address', () => {
  expect(networkVerdictOf(settings, 'host.docker.internal', ['172.17.0.1'])).toBe('internal')
  expect(networkVerdictOf(settings, 'rebound.example.com', ['93.184.216.34', '10.0.0.1'])).toBe('internal')
  expect(networkVerdictOf({ ...settings, blockInternalNetworks: false }, 'host.docker.internal', ['172.17.0.1'])).toBe(
    'allowed',
  )
  expect(
    networkVerdictOf({ ...settings, allowedInternalAddresses: ['staging.internal'] }, 'Staging.Internal.', [
      '10.0.0.5',
    ]),
  ).toBe('allowed')
  expect(
    networkVerdictOf({ ...settings, allowedInternalAddresses: ['10.0.0.5'] }, 'staging.internal', ['10.0.0.5']),
  ).toBe('allowed')
})

test('a host is reachable only when every address it resolves to is public or named by the admin', () => {
  const allowed = { ...settings, allowedInternalAddresses: ['10.0.0.5'] }
  expect(networkVerdictOf(allowed, 'rebound.example.com', ['169.254.169.254', '10.0.0.5'])).toBe('internal')
  expect(networkVerdictOf(allowed, 'rebound.example.com', ['10.0.0.5', '10.0.0.6'])).toBe('internal')
  expect(networkVerdictOf(allowed, 'staging.example.com', ['10.0.0.5', '93.184.216.34'])).toBe('allowed')
})

test('a CONNECT target keeps the port it names, the default ports included, and an IPv6 address in brackets', () => {
  expect(connectTargetOf('example.com:80')).toEqual({ hostname: 'example.com', port: 80 })
  expect(connectTargetOf('example.com:443')).toEqual({ hostname: 'example.com', port: 443 })
  expect(connectTargetOf('[::1]:3000')).toEqual({ hostname: '[::1]', port: 3000 })
  for (const target of ['example.com', 'example.com:0', 'example.com:70000', 'a:b:80'])
    expect(() => connectTargetOf(target)).toThrow()
})

test('blocked sites win over allowed ones and include their subdomains, before any address lookup', () => {
  const sites = { ...settings, allowedSites: ['example.com'], blockedSites: ['admin.example.com'] }
  expect(siteVerdictOf(sites, 'www.example.com')).toBe('allowed')
  expect(siteVerdictOf(sites, 'Admin.Example.com.')).toBe('blocked_site')
  expect(siteVerdictOf(sites, 'notexample.com')).toBe('site_not_allowed')
  expect(siteVerdictOf(settings, 'anything.example')).toBe('allowed')
  for (const runtime of ['localhost', 'app.localhost', '127.0.0.1', '::1'])
    expect(siteVerdictOf(sites, runtime)).toBe('allowed')
})

const blocked = []
const proxy = await createPolicyProxy({
  settings: () => ({ ...settings, blockedSites: ['blocked.test'] }),
  onBlocked: (block) => blocked.push(block),
})
afterAll(() => proxy.close())

const connectThroughProxy = (target) =>
  new Promise((resolve, reject) => {
    const socket = connect(proxy.port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\n\r\n`))
    socket.once('data', (data) => {
      resolve(String(data).split('\r\n')[0])
      socket.destroy()
    })
    socket.on('error', reject)
  })

test('the proxy refuses a tunnel to an internal address or a blocked site and says which host it refused', async () => {
  expect(await connectThroughProxy('10.255.255.1:443')).toBe('HTTP/1.1 403 Forbidden')
  expect(await connectThroughProxy('169.254.169.254:80')).toBe('HTTP/1.1 403 Forbidden')
  expect(await connectThroughProxy('blocked.test:443')).toBe('HTTP/1.1 403 Forbidden')
  expect(blocked).toEqual([
    { host: '10.255.255.1', reason: 'internal' },
    { host: '169.254.169.254', reason: 'internal' },
    { host: 'blocked.test', reason: 'blocked_site' },
  ])
})

test('the proxy tunnels to loopback', async () => {
  const listening = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data: () => {} } })
  try {
    expect(await connectThroughProxy(`127.0.0.1:${listening.port}`)).toBe('HTTP/1.1 200 Connection Established')
  } finally {
    listening.stop(true)
  }
})
