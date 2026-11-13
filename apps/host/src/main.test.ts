import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

const directory = mkdtempSync(join(tmpdir(), 'spyria-host-main-'))
const dockerSocket = join(directory, 'docker.sock')
const dockerPaths: string[] = []
const restartPolicyUpdates: unknown[] = []
let isArchiveUnreadable = false
const docker = Bun.serve({
  unix: dockerSocket,
  fetch: async (request) => {
    const { pathname } = new URL(request.url)
    dockerPaths.push(pathname)
    if (pathname === '/info') await Bun.sleep(300)
    if (pathname.endsWith('/archive'))
      return isArchiveUnreadable
        ? new Response('Docker is busy', { status: 500 })
        : Response.json({ message: 'No such file' }, { status: 404 })
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
afterAll(async () => {
  for (const host of startedHosts) host.kill()
  await Promise.all(startedHosts.map((host) => host.exited))
  void docker.stop(true)
  void spyria.stop(true)
  void refusingSpyria.stop(true)
  rmSync(directory, { recursive: true, force: true })
})
const startedHosts: ReturnType<typeof Bun.spawn>[] = []
const startupMilliseconds = 30_000
const testMilliseconds = 60_000
const spawnHost = (...[command, options]: Parameters<typeof Bun.spawn>) => {
  const host = Bun.spawn(command, options)
  startedHosts.push(host)
  return host
}
const startHost = (spyriaPort: number | undefined) =>
  spawnHost(['bun', new URL('./main.ts', import.meta.url).pathname, `ws://127.0.0.1:${spyriaPort}/h/CODE`], {
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

test(
  'a connection closed while the hello reads the system leaves no heartbeat behind',
  async () => {
    writeFileSync(join(directory, 'token'), 'host-token')
    const host = startHost(spyria.port)
    try {
      for (
        const deadline = Date.now() + startupMilliseconds;
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
  },
  testMilliseconds,
)

test(
  'a refused host turns off the restart policy of its own container before it exits',
  async () => {
    writeFileSync(join(directory, 'token'), 'host-token')
    const host = startHost(refusingSpyria.port)
    expect(await host.exited).toBe(1)
    expect(restartPolicyUpdates).toEqual([{ RestartPolicy: { Name: 'no' } }])
  },
  testMilliseconds,
)

test(
  'a refused host logs the reason Spyria sent before the close, not the shortened close reason',
  async () => {
    writeFileSync(join(directory, 'token'), 'host-token')
    const reason = `This host is out of date: update it with ${'x'.repeat(200)}`
    const explainingSpyria = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
      websocket: {
        message: (socket) => {
          socket.send(JSON.stringify({ type: 'refused', reason }))
          socket.close(4001, reason.slice(0, 120))
        },
      },
    })
    const host = spawnHost(
      ['bun', new URL('./main.ts', import.meta.url).pathname, `ws://127.0.0.1:${explainingSpyria.port}/h/CODE`],
      {
        env: {
          ...process.env,
          DOCKER_SOCKET: dockerSocket,
          SPYRIA_DEPLOYMENT: 'spyria',
          SPYRIA_HOST_STATE_DIR: directory,
          SPYRIA_HOST_GATEWAY_PORT: '0',
          OTEL_EXPORTER_OTLP_ENDPOINT: '',
        },
        stdout: 'pipe',
        stderr: 'ignore',
      },
    )
    try {
      expect(await host.exited).toBe(1)
      const lines = (await new Response(host.stdout as ReadableStream).text())
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      expect(lines.find((line) => line['event.name'] === 'host.refused')?.['host.close_reason']).toBe(reason)
    } finally {
      void explainingSpyria.stop(true)
    }
  },
  testMilliseconds,
)

test(
  'a personal host told its sign-ins changed reads them and sends a heartbeat at once',
  async () => {
    writeFileSync(join(directory, 'token'), 'host-token')
    const frames: { type: string }[] = []
    const listeningSpyria = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
      websocket: { message: (_, message) => void frames.push(JSON.parse(String(message))) },
    })
    const host = spawnHost(
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
      for (const deadline = Date.now() + startupMilliseconds; !typesOf().includes('hello'); await Bun.sleep(20))
        if (Date.now() > deadline) throw new Error('The host did not say hello')
      host.kill('SIGUSR2')
      for (const deadline = Date.now() + startupMilliseconds; !typesOf().includes('heartbeat'); await Bun.sleep(20))
        if (Date.now() > deadline) throw new Error('The host sent no heartbeat')
      expect(typesOf()).toEqual(['hello', 'heartbeat'])
    } finally {
      host.kill()
      await host.exited
      void listeningSpyria.stop(true)
    }
  },
  testMilliseconds,
)

test(
  'a personal host whose sign-ins cannot be read says no hello until they can, so nothing is relayed unredacted',
  async () => {
    writeFileSync(join(directory, 'token'), 'host-token')
    isArchiveUnreadable = true
    let openedConnections = 0
    const frames: { type: string }[] = []
    const listeningSpyria = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
      websocket: {
        open: () => void openedConnections++,
        message: (_, message) => void frames.push(JSON.parse(String(message))),
      },
    })
    const host = spawnHost(
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
    try {
      for (const deadline = Date.now() + startupMilliseconds; openedConnections < 2; await Bun.sleep(20))
        if (Date.now() > deadline) throw new Error('The host did not connect again after failing its hello')
      expect(frames).toEqual([])
      isArchiveUnreadable = false
      for (
        const deadline = Date.now() + startupMilliseconds;
        !frames.some(({ type }) => type === 'hello');
        await Bun.sleep(20)
      )
        if (Date.now() > deadline) throw new Error('The host did not say hello once its sign-ins were readable')
    } finally {
      isArchiveUnreadable = false
      host.kill()
      await host.exited
      void listeningSpyria.stop(true)
    }
  },
  testMilliseconds,
)

test(
  'a host started without arguments takes its claim URL from SPYRIA_HOST_CLAIM_URL, so the code stays off its command line',
  async () => {
    rmSync(join(directory, 'token'), { force: true })
    const frames: { type: string; code?: string }[] = []
    const listeningSpyria = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
      websocket: { message: (_, message) => void frames.push(JSON.parse(String(message))) },
    })
    const host = spawnHost(['bun', new URL('./main.ts', import.meta.url).pathname], {
      env: {
        ...process.env,
        DOCKER_SOCKET: dockerSocket,
        SPYRIA_DEPLOYMENT: 'spyria',
        SPYRIA_HOST_STATE_DIR: directory,
        SPYRIA_HOST_GATEWAY_PORT: '0',
        SPYRIA_HOST_CLAIM_URL: `ws://127.0.0.1:${listeningSpyria.port}/h/ENVCODE`,
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    try {
      for (const deadline = Date.now() + startupMilliseconds; frames.length === 0; await Bun.sleep(20))
        if (Date.now() > deadline) throw new Error('The host did not claim')
      expect(frames[0]).toEqual({ type: 'claim', code: 'ENVCODE' })
    } finally {
      host.kill()
      await host.exited
      void listeningSpyria.stop(true)
    }
  },
  testMilliseconds,
)

test(
  'a host given HTTP_PROXY dials Spyria through that proxy',
  async () => {
    writeFileSync(join(directory, 'token'), 'host-token')
    const tunnels: string[] = []
    const proxy = Bun.listen<{ upstream?: Socket }>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        data: (client, data) => {
          if (client.data?.upstream) return void client.data.upstream.write(data)
          const [, target = ''] = data.toString().match(/^CONNECT (\S+) /) ?? []
          tunnels.push(target)
          const [host, port] = target.split(':')
          const upstream = connect(Number(port), host, () =>
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n'),
          )
          upstream.on('data', (chunk) => client.write(chunk))
          upstream.on('close', () => client.end())
          client.data = { upstream }
        },
        close: (client) => void client.data?.upstream?.destroy(),
      },
    })
    const frames: { type: string }[] = []
    const listeningSpyria = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
      websocket: { message: (_, message) => void frames.push(JSON.parse(String(message))) },
    })
    const host = spawnHost(
      ['bun', new URL('./main.ts', import.meta.url).pathname, `ws://127.0.0.1:${listeningSpyria.port}/h/CODE`],
      {
        env: {
          ...process.env,
          DOCKER_SOCKET: dockerSocket,
          SPYRIA_DEPLOYMENT: 'spyria',
          SPYRIA_HOST_STATE_DIR: directory,
          SPYRIA_HOST_GATEWAY_PORT: '0',
          SPYRIA_HOST_HEARTBEAT_MS: '600000',
          OTEL_EXPORTER_OTLP_ENDPOINT: '',
          HTTP_PROXY: `http://127.0.0.1:${proxy.port}`,
          NO_PROXY: '',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    )
    try {
      for (
        const deadline = Date.now() + startupMilliseconds;
        !frames.some(({ type }) => type === 'hello');
        await Bun.sleep(20)
      )
        if (Date.now() > deadline) throw new Error('The host did not say hello')
      expect(tunnels).toEqual([`127.0.0.1:${listeningSpyria.port}`])
    } finally {
      host.kill()
      await host.exited
      void listeningSpyria.stop(true)
      proxy.stop(true)
    }
  },
  testMilliseconds,
)

test(
  'a host paired again after its token was refused says hello with its new token after its next disconnect',
  async () => {
    writeFileSync(join(directory, 'token'), 'refused-token')
    const firstFrames: { type: string; token?: string }[] = []
    let openedConnections = 0
    const repairingSpyria = Bun.serve({
      port: 0,
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('Not found', { status: 404 })),
      websocket: {
        open: () => void openedConnections++,
        message: (socket, message) => {
          const frame = JSON.parse(String(message))
          if (firstFrames.length < openedConnections) firstFrames.push(frame)
          if (frame.type === 'hello' && frame.token === 'refused-token') socket.close(4001, 'Unknown token')
          else if (frame.type === 'claim') socket.send(JSON.stringify({ type: 'token', token: 'new-token' }))
          else if (frame.type === 'hello' && openedConnections === 2) socket.close(1011, 'Restarting')
        },
      },
    })
    const host = startHost(repairingSpyria.port)
    try {
      for (const deadline = Date.now() + startupMilliseconds; firstFrames.length < 3; await Bun.sleep(20))
        if (Date.now() > deadline) throw new Error('The host did not connect a third time')
      expect(firstFrames.map(({ type, token }) => ({ type, token }))).toEqual([
        { type: 'hello', token: 'refused-token' },
        { type: 'claim', token: undefined },
        { type: 'hello', token: 'new-token' },
      ])
    } finally {
      host.kill()
      await host.exited
      void repairingSpyria.stop(true)
    }
  },
  testMilliseconds,
)
