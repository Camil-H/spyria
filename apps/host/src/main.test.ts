import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'spyria-host-main-'))
const dockerSocket = join(directory, 'docker.sock')
const dockerPaths: string[] = []
const docker = Bun.serve({
  unix: dockerSocket,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    dockerPaths.push(pathname)
    if (pathname === '/info') await Bun.sleep(300)
    return Response.json(pathname === '/info' ? { NCPU: 2, MemTotal: 8 * 1024 ** 3, ServerVersion: '29' } : [])
  },
})
let connections = 0
const spyria = Bun.serve({
  port: 0,
  fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
  websocket: {
    open: (socket) => {
      connections++
      socket.close(1011, 'Closed before the hello')
    },
    message: () => {},
  },
})
afterAll(() => {
  void docker.stop(true)
  void spyria.stop(true)
  rmSync(directory, { recursive: true, force: true })
})

test('a connection closed while the hello reads the system leaves no heartbeat behind', async () => {
  writeFileSync(join(directory, 'token'), 'host-token')
  const host = Bun.spawn(
    ['bun', new URL('./main.ts', import.meta.url).pathname, `ws://127.0.0.1:${spyria.port}/h/CODE`],
    {
      env: {
        ...process.env,
        DOCKER_SOCKET: dockerSocket,
        SPYRIA_HOST_STATE_DIR: directory,
        SPYRIA_HOST_GATEWAY_PORT: '0',
        SPYRIA_HOST_HEARTBEAT_MS: '20',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    },
  )
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
