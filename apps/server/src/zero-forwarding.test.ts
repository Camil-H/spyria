import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { serverWebSocket } from './runtime-hosts/gateway.ts'
import { createZeroForwarding } from './zero-forwarding.ts'

type UpstreamSocketData = { protocol: string }
const upstreamRequests: { method: string; path: string; headers: Record<string, string>; body: string }[] = []
const upstreamUpgrades: string[] = []
const largeMessage = 'z'.repeat(20 * 1024 * 1024)

const upstream = Bun.serve<UpstreamSocketData>({
  port: 0,
  async fetch(request, server) {
    const { pathname, search } = new URL(request.url)
    if (request.headers.get('upgrade') === 'websocket') {
      upstreamUpgrades.push(pathname)
      const protocol = request.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim() ?? ''
      if (pathname === '/sync/refused') return new Response('no sync here', { status: 403 })
      if (pathname === '/sync/slow') await Bun.sleep(200)
      server.upgrade(request, {
        headers: protocol ? { 'sec-websocket-protocol': protocol } : {},
        data: { protocol },
      })
      return
    }
    upstreamRequests.push({
      method: request.method,
      path: `${pathname}${search}`,
      headers: Object.fromEntries(request.headers),
      body: await request.text(),
    })
    if (pathname === '/keepalive') return new Response('ok', { headers: { 'x-upstream': 'zero', connection: 'close' } })
    if (pathname === '/slow') {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first,'))
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode('second'))
            controller.close()
          }, 100)
        },
      })
      return new Response(body, { status: 201 })
    }
    return new Response('not here', { status: 404 })
  },
  websocket: {
    maxPayloadLength: 64 * 1024 * 1024,
    open(socket) {
      socket.send(`welcome ${socket.data.protocol}`)
    },
    message(socket, message) {
      const text = String(message)
      if (text === 'close me') socket.close(4123, 'as asked')
      else if (text === 'large please') socket.send(largeMessage)
      else socket.send(typeof message === 'string' ? `echo ${text}` : message)
    },
  },
})

const app = new Hono().all('/zero/*', createZeroForwarding(upstream.url.origin))
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: serverWebSocket })
const serverUrl = server.url.origin
const socketUrl = serverUrl.replace('http', 'ws')

const openSocket = (path: string, protocols?: string[]) =>
  new Promise<{ socket: WebSocket; messages: string[]; closed: Promise<CloseEvent> }>((resolve, reject) => {
    const socket = new WebSocket(`${socketUrl}${path}`, protocols ?? [])
    const messages: string[] = []
    const closed = new Promise<CloseEvent>((resolveClose) => {
      socket.onclose = (event) => resolveClose(event)
    })
    socket.onmessage = (event) => messages.push(String(event.data))
    socket.onopen = () => resolve({ socket, messages, closed })
    socket.onerror = () => reject(new Error('The socket did not open'))
  })
const waitFor = async (condition: () => boolean, milliseconds = 5000) => {
  for (const deadline = Date.now() + milliseconds; !condition(); await Bun.sleep(10))
    if (Date.now() > deadline) throw new Error('Timed out')
}

beforeAll(() => {
  upstreamRequests.length = 0
})
afterAll(() => {
  server.stop(true)
  upstream.stop(true)
})

test('forwards an HTTP request under /zero to zero-cache without the prefix, with its query, method, body and headers, and returns its answer', async () => {
  const response = await fetch(`${serverUrl}/zero/keepalive?from=test`, {
    method: 'POST',
    headers: { 'x-client': 'browser', 'content-type': 'text/plain', 'proxy-authorization': 'Basic abc' },
    body: 'ping',
  })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('ok')
  expect(response.headers.get('x-upstream')).toBe('zero')
  expect(response.headers.get('connection')).not.toBe('close')
  const forwarded = upstreamRequests.at(-1)
  expect(forwarded).toMatchObject({ method: 'POST', path: '/keepalive?from=test', body: 'ping' })
  expect(forwarded?.headers['x-client']).toBe('browser')
  expect(forwarded?.headers['proxy-authorization']).toBeUndefined()
})

test('streams the upstream response as it arrives and keeps its status', async () => {
  const response = await fetch(`${serverUrl}/zero/slow`)
  expect(response.status).toBe(201)
  const reader = response.body?.getReader()
  const first = await reader?.read()
  expect(new TextDecoder().decode(first?.value)).toBe('first,')
  const second = await reader?.read()
  expect(new TextDecoder().decode(second?.value)).toBe('second')
})

test('answers 404 from zero-cache as is', async () => {
  const response = await fetch(`${serverUrl}/zero/nothing`)
  expect(response.status).toBe(404)
  expect(await response.text()).toBe('not here')
})

test('forwards a WebSocket under /zero with its subprotocol, relays messages both ways including a 20 MiB one, and propagates the close code', async () => {
  const { socket, messages, closed } = await openSocket('/zero/sync/v51/connect?clientID=c1', ['zero.v1.init'])
  expect(socket.protocol).toBe('zero.v1.init')
  await waitFor(() => messages.length === 1)
  expect(messages[0]).toBe('welcome zero.v1.init')
  socket.send('hello')
  await waitFor(() => messages.length === 2)
  expect(messages[1]).toBe('echo hello')
  socket.send('large please')
  await waitFor(() => messages.length === 3, 20_000)
  expect(messages[2]?.length).toBe(largeMessage.length)
  socket.send('close me')
  const closeEvent = await closed
  expect(closeEvent.code).toBe(4123)
  expect(closeEvent.reason).toBe('as asked')
})

test('closing the browser side closes the zero-cache side, and a refused upgrade upstream closes the browser socket as unreachable', async () => {
  const { socket, closed } = await openSocket('/zero/sync/v51/connect')
  socket.close(1000, 'bye')
  expect((await closed).code).toBe(1000)
  const refused = await openSocket('/zero/sync/refused')
  const refusedClose = await refused.closed
  expect(refusedClose.code).toBe(1011)
  expect(refusedClose.reason).toBe('The sync service is unreachable')
})

test('opens no zero-cache socket for an upgrade the server does not accept', async () => {
  upstreamUpgrades.length = 0
  const notAccepted = await fetch(`${serverUrl}/zero/sync/v51/connect`, {
    headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-version': '13' },
  })
  expect(notAccepted.status).toBe(400)
  await Bun.sleep(50)
  expect(upstreamUpgrades).toEqual([])
})

test('holds what the browser sends while zero-cache is still opening, then relays it in order', async () => {
  const { socket, messages } = await openSocket('/zero/sync/slow', ['zero.v1.init'])
  socket.send('first')
  socket.send('second')
  await waitFor(() => messages.length === 3)
  expect(messages).toEqual(['welcome zero.v1.init', 'echo first', 'echo second'])
  socket.close()
})

test('closes the browser socket when it sends more than 1 MiB before zero-cache opens', async () => {
  const { socket, closed } = await openSocket('/zero/sync/slow', ['zero.v1.init'])
  socket.send('x'.repeat(1024 * 1024 + 1))
  const closeEvent = await closed
  expect(closeEvent.code).toBe(1009)
  expect(closeEvent.reason).toBe('Too much was sent before the sync service answered')
})

test('answers 502 when zero-cache is unreachable', async () => {
  const unreachableApp = new Hono().all('/zero/*', createZeroForwarding('http://127.0.0.1:1'))
  const response = await unreachableApp.request('/zero/keepalive')
  expect(response.status).toBe(502)
  expect(await response.text()).toBe('The sync service is unreachable')
})

test('a path that looks like another host after the prefix stays on zero-cache, for HTTP and for a WebSocket', async () => {
  const other = Bun.serve({ port: 0, fetch: () => new Response('leaked') })
  try {
    const response = await fetch(`${serverUrl}/zero//127.0.0.1:${other.port}/secret`)
    expect(response.status).toBe(404)
    expect(await response.text()).toBe('not here')
    expect(upstreamRequests.at(-1)?.path).toMatch(new RegExp(`^/+127\\.0\\.0\\.1:${other.port}/secret$`))
    const { socket, messages } = await openSocket(`/zero//127.0.0.1:${other.port}/sync`, ['zero.v1.init'])
    await waitFor(() => messages.length === 1)
    expect(messages[0]).toBe('welcome zero.v1.init')
    socket.close()
  } finally {
    other.stop(true)
  }
})
