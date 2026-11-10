import { expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { rateBudgets } from './rate-limits.ts'
import { captureLogs, openSharedTestApp, testAuthSettings } from './testing/testing.ts'

const { database } = await openSharedTestApp()

test('WebSocket upgrades under /zero answer 429 past their budget per address, while another address and plain requests still reach zero-cache', async () => {
  const limitedApp = createApp({
    database,
    ...testAuthSettings,
    rateLimits: rateBudgets,
    zeroUrl: 'http://127.0.0.1:1',
  })
  const upgradeFrom = (address: string) =>
    limitedApp.request(
      '/zero/sync/v51/connect',
      { headers: { upgrade: 'websocket', connection: 'upgrade' } },
      { upgrade: () => false, requestIP: () => ({ address }) },
    )
  const logs = captureLogs()
  try {
    for (let sent = 0; sent < rateBudgets.zeroConnections.count; sent++)
      expect((await upgradeFrom('203.0.113.7')).status).toBe(400)
    const refused = await upgradeFrom('203.0.113.7')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await upgradeFrom('198.51.100.4')).status).toBe(400)
    const plain = await limitedApp.request('/zero/keepalive', {}, { requestIP: () => ({ address: '203.0.113.7' }) })
    expect(plain.status).toBe(502)
  } finally {
    logs.restore()
  }
  expect(logs.events.filter((logged) => logged.event === 'rate_limit.hit').map((logged) => logged.attributes)).toEqual([
    { 'rate_limit.name': 'zeroConnections' },
  ])
})
