import { expect, test } from 'bun:test'
import { proxyOf, takeProxySettings } from './proxy.ts'

const proxies = { HTTPS_PROXY: 'http://secure-proxy:3128', http_proxy: 'http://plain-proxy:3128' }

test.each([
  ['wss://spyria.example.com/host', proxies, 'http://secure-proxy:3128'],
  ['ws://spyria.internal:3000/host', proxies, 'http://plain-proxy:3128'],
  ['wss://spyria.example.com/host', { https_proxy: 'http://lower:3128' }, 'http://lower:3128'],
  ['wss://spyria.example.com/host', { ...proxies, NO_PROXY: 'localhost, .example.com' }, undefined],
  ['wss://spyria.example.com/host', { ...proxies, no_proxy: 'spyria.example.com:443' }, undefined],
  ['wss://spyria.example.com/host', { ...proxies, NO_PROXY: '*' }, undefined],
  ['wss://spyria.example.com/host', { ...proxies, NO_PROXY: 'example.org,ample.com' }, 'http://secure-proxy:3128'],
  ['ws://spyria.internal:3000/host', { HTTPS_PROXY: 'http://secure-proxy:3128' }, undefined],
])('the host dials %s through the proxy its environment names: %o', (url, environment, expected) => {
  expect(proxyOf(new URL(url), environment)).toBe(expected)
})

test('the host takes the proxy settings out of its environment, so its own calls to runtimes never go through them', () => {
  const environment: Record<string, string | undefined> = { ...proxies, NO_PROXY: 'localhost', PATH: '/bin' }
  expect(takeProxySettings(environment)).toMatchObject({ ...proxies, NO_PROXY: 'localhost' })
  expect(environment).toEqual({ PATH: '/bin' })
})
