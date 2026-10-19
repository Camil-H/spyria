import { afterAll, expect, test } from 'bun:test'
import { workspaceId } from '@spyria/kernel'
import { createBifrostUsageLogs } from './bifrost-usage-logs.ts'

const hangingGateway = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
afterAll(() => hangingGateway.stop(true))

test('the usage fetch gives up after the timeout', async () => {
  const usageLogs = createBifrostUsageLogs({
    url: `http://localhost:${hangingGateway.port}`,
    adminUser: 'admin',
    adminPassword: 'secret',
    timeoutMilliseconds: 100,
  })
  const startedAt = Date.now()
  await expect(usageLogs.since(workspaceId('workspace-1'), new Date())).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(Date.now() - startedAt).toBeLessThan(2_000)
})
