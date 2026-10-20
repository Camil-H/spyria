import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { createTestDatabase, databaseUrlOf, testGatewayAdmin } from '@spyria/db/testing'
import { openSharedTestApp } from './testing/testing.ts'

setDefaultTimeout(60_000)

const { gateway } = await openSharedTestApp()
const throwawayDatabase = await createTestDatabase()
const gatewayRequests: string[] = []
const gatewayProxy = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url)
    gatewayRequests.push(`${request.method} ${url.pathname}`)
    return fetch(`${gateway.url}${url.pathname}${url.search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
  },
})
const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const probedPort = Number(probe.port)
  void probe.stop(true)
  return probedPort
}
const port = freePort()
const serverUrl = `http://127.0.0.1:${port}`
const productionEnvironment = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  PORT: String(port),
  DATABASE_URL: databaseUrlOf(throwawayDatabase.name),
  SPYRIA_ENV: 'production',
  SPYRIA_AUTH_MODE: 'sso',
  SPYRIA_TOKEN_SECRET: 'production-test-token-secret-0123456789abcdef',
  SPYRIA_SECRETS_KEY: 'production-test-secrets-key-0123456789abcdef',
  SPYRIA_APP_ORIGIN: 'https://spyria.example',
  SPYRIA_OIDC_REDIRECT_URI: 'https://spyria.example/auth/callback',
  SPYRIA_SMTP_URL: 'smtp://127.0.0.1:9',
  SPYRIA_MAIL_FROM: 'Spyria <spyria@spyria.example>',
  SPYRIA_GATEWAY_URL: gatewayProxy.url.origin,
  SPYRIA_GATEWAY_ADMIN_USER: testGatewayAdmin.user,
  SPYRIA_GATEWAY_ADMIN_PASSWORD: testGatewayAdmin.password,
}
const spawned: Bun.Subprocess[] = []
const startServer = (environment: Record<string, string>) => {
  const server = Bun.spawn(['bun', 'apps/server/src/index.ts'], {
    cwd: new URL('../../..', import.meta.url).pathname,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  spawned.push(server)
  return server
}
const healthOf = async () => {
  const response = await fetch(`${serverUrl}/health`)
  return { status: response.status, body: await response.json() }
}

afterAll(async () => {
  for (const server of spawned) server.kill('SIGKILL')
  void gatewayProxy.stop(true)
  await throwawayDatabase.drop()
})

test('a broken production environment refuses to start and lists every problem', async () => {
  const server = startServer({
    ...productionEnvironment,
    SPYRIA_AUTH_MODE: 'dex',
    SPYRIA_SECRETS_KEY: 'too-short',
    SPYRIA_APP_ORIGIN: 'http://localhost:5173',
    SPYRIA_GATEWAY_ADMIN_PASSWORD: 'spyria-dev-gateway',
  })
  expect(await server.exited).toBe(1)
  const printed = await new Response(server.stderr).text()
  for (const problem of [
    'SPYRIA_AUTH_MODE must be sso.',
    'SPYRIA_SECRETS_KEY must be at least 32 characters.',
    'SPYRIA_APP_ORIGIN must start with https://.',
    'SPYRIA_OIDC_REDIRECT_URI must be on SPYRIA_APP_ORIGIN.',
    'SPYRIA_GATEWAY_ADMIN_PASSWORD must not be a development default.',
  ])
    expect(printed).toContain(problem)
})

test('a correct production environment starts without fakes, reports its health and stops on SIGTERM', async () => {
  const server = startServer(productionEnvironment)
  for (let attempt = 1; !(await fetch(`${serverUrl}/health`).catch(() => undefined)); attempt++) {
    if (attempt === 300 || server.exitCode !== null) {
      server.kill('SIGKILL')
      throw new Error(`The server did not start: ${await new Response(server.stderr).text()}`)
    }
    await Bun.sleep(100)
  }
  expect((await fetch(`${serverUrl}/fake-llm/v1/models`)).status).toBe(404)
  expect(gatewayRequests.filter((request) => request.startsWith('POST /api/providers'))).toEqual([])
  expect(await healthOf()).toEqual({ status: 200, body: { status: 'ok' } })
  await gatewayProxy.stop(true)
  expect(await healthOf()).toEqual({ status: 503, body: { status: 'degraded', failing: ['gateway'] } })
  const stoppingAt = performance.now()
  server.kill('SIGTERM')
  expect(await server.exited).toBe(0)
  expect(performance.now() - stoppingAt).toBeLessThan(10_000)
})
