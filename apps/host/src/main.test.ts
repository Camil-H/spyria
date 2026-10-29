import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'spyria-host-main-'))
const dockerSocket = join(directory, 'docker.sock')
const dockerPaths: string[] = []
const restartPolicyUpdates: unknown[] = []
const docker = Bun.serve({
  unix: dockerSocket,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    dockerPaths.push(pathname)
    if (pathname === '/info') await Bun.sleep(300)
    if (pathname === '/containers/spyria-host/json') return Response.json({ Config: { Hostname: hostname() } })
    if (pathname === '/containers/spyria-host/update') restartPolicyUpdates.push(await request.json())
    return Response.json(pathname === '/info' ? { NCPU: 2, MemTotal: 8 * 1024 ** 3, ServerVersion: '29' } : [])
  },
})
const fakeSpyria = (close: [code: number, reason: string]) =>
  Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
    websocket: {
      open: (socket) => {
        connections++
        socket.close(...close)
      },
      message: () => {},
    },
  })
let connections = 0
const spyria = fakeSpyria([1011, 'Closed before the hello'])
const refusingSpyria = fakeSpyria([4001, 'This host was removed'])
afterAll(() => {
  void docker.stop(true)
  void spyria.stop(true)
  void refusingSpyria.stop(true)
  rmSync(directory, { recursive: true, force: true })
})
const startHost = (spyriaPort: number | undefined) =>
  Bun.spawn(['bun', new URL('./main.ts', import.meta.url).pathname, `ws://127.0.0.1:${spyriaPort}/h/CODE`], {
    env: {
      ...process.env,
      DOCKER_SOCKET: dockerSocket,
      SPYRIA_DEPLOYMENT: 'spyria',
      SPYRIA_HOST_STATE_DIR: directory,
      SPYRIA_HOST_GATEWAY_PORT: '0',
      SPYRIA_HOST_HEARTBEAT_MS: '20',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })

test('a connection closed while the hello reads the system leaves no heartbeat behind', async () => {
  writeFileSync(join(directory, 'token'), 'host-token')
  const host = startHost(spyria.port)
  try {
    for (
      const deadline = Date.now() + 5_000;
      dockerPaths.filter((path) => path === '/info').length < 2;
      await Bun.sleep(20)
    )
      if (Date.now() > deadline) throw new Error('The host did not say hello twice')
    await Bun.sleep(400)
    expect(connections).toBeGreaterThanOrEqual(2)
    expect(dockerPaths.filter((path) => path === '/containers/json')).toEqual([])
  } finally {
    host.kill()
    await host.exited
  }
}, 15_000)

test('a refused host turns off the restart policy of its own container before it exits', async () => {
  writeFileSync(join(directory, 'token'), 'host-token')
  const host = startHost(refusingSpyria.port)
  expect(await host.exited).toBe(1)
  expect(restartPolicyUpdates).toEqual([{ RestartPolicy: { Name: 'no' } }])
}, 15_000)

test('a personal host told its sign-ins changed reads them and sends a heartbeat at once', async () => {
  writeFileSync(join(directory, 'token'), 'host-token')
  const frames: { type: string }[] = []
  const listeningSpyria = Bun.serve({
    port: 0,
    fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
    websocket: { message: (_, message) => void frames.push(JSON.parse(String(message))) },
  })
  const host = Bun.spawn(
    [
      'bun',
      new URL('./main.ts', import.meta.url).pathname,
      '--personal',
      `ws://127.0.0.1:${listeningSpyria.port}/h/CODE`,
    ],
    {
      env: {
        ...process.env,
        DOCKER_SOCKET: dockerSocket,
        SPYRIA_DEPLOYMENT: 'spyria',
        SPYRIA_HOST_STATE_DIR: directory,
        SPYRIA_HOST_GATEWAY_PORT: '0',
        SPYRIA_HOST_HEARTBEAT_MS: '600000',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
  const typesOf = () => frames.map(({ type }) => type)
  try {
    for (const deadline = Date.now() + 5_000; !typesOf().includes('hello'); await Bun.sleep(20))
      if (Date.now() > deadline) throw new Error('The host did not say hello')
    host.kill('SIGUSR2')
    for (const deadline = Date.now() + 5_000; !typesOf().includes('heartbeat'); await Bun.sleep(20))
      if (Date.now() > deadline) throw new Error('The host sent no heartbeat')
    expect(typesOf()).toEqual(['hello', 'heartbeat'])
  } finally {
    host.kill()
    await host.exited
    void listeningSpyria.stop(true)
  }
}, 15_000)
