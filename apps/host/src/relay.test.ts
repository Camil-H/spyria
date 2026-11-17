import { afterAll, expect, test } from 'bun:test'
import type { BrowserStreamListener } from './browsers.ts'
import { bodyFramesOf, createRelay, frameTextOf, relayChunkBytes } from './relay.ts'
import { nextFrameOf, waitFor } from './testing.ts'

const spyriaAgent = Bun.serve({
  port: 0,
  fetch: (request, server) =>
    server.upgrade(request)
      ? undefined
      : new Response(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('x-session-api-key')}`, {
          status: 201,
        }),
  websocket: {
    message: (socket, message) => {
      socket.send(`echo ${message}`)
    },
  },
})
afterAll(() => spyriaAgent.stop(true))

const relayTo = (
  agent: { port?: number },
  options: Omit<Partial<Parameters<typeof createRelay>[0]>, 'addressOf' | 'send'> = {},
) => {
  const sent: Record<string, unknown>[] = []
  const relay = createRelay({
    addressOf: async (runtimeId) => {
      if (runtimeId !== 'runtime-1') throw new Error('refused: not a managed runtime')
      return `http://localhost:${agent.port}`
    },
    send: (frame) => sent.push(frame),
    ...options,
  })
  return { relay, sent, nextOf: (type: string) => nextFrameOf(sent, type) }
}

test('relays an HTTP call and answers with its status and body', async () => {
  const { relay, nextOf } = relayTo(spyriaAgent)
  await relay.handle({
    type: 'http',
    sid: 1,
    runtimeId: 'runtime-1',
    method: 'POST',
    path: '/api/x',
    headers: { 'x-session-api-key': 'key' },
    body: '{}',
  })
  expect(await nextOf('http_res')).toMatchObject({ sid: 1, status: 201, body: 'POST /api/x key' })
})

test('answers an error for an unmanaged runtime instead of relaying', async () => {
  const { relay, nextOf } = relayTo(spyriaAgent)
  await relay.handle({ type: 'http', sid: 2, runtimeId: 'other', method: 'GET', path: '/' })
  expect(await nextOf('http_res')).toEqual({ type: 'http_res', sid: 2, error: 'refused: not a managed runtime' })
})

test('relays a WebSocket stream both ways and closes it', async () => {
  const { relay, nextOf } = relayTo(spyriaAgent)
  await relay.handle({ type: 'ws_connect', sid: 3, runtimeId: 'runtime-1', path: '/sockets/events/1' })
  await relay.handle({ type: 'ws_msg', sid: 3, data: 'queued before open' })
  expect(await nextOf('ws_open')).toEqual({ type: 'ws_open', sid: 3 })
  expect(await nextOf('ws_msg')).toEqual({ type: 'ws_msg', sid: 3, data: 'echo queued before open' })
  await relay.handle({ type: 'ws_msg', sid: 3, data: 'hello' })
  expect(await nextOf('ws_msg')).toEqual({ type: 'ws_msg', sid: 3, data: 'echo hello' })
  await relay.handle({ type: 'ws_close', sid: 3 })
  expect(await nextOf('ws_close')).toMatchObject({ type: 'ws_close', sid: 3 })
})

test('a stream closed while its runtime address is looked up is never opened', async () => {
  const { relay, sent } = relayTo(spyriaAgent)
  const connecting = relay.handle({ type: 'ws_connect', sid: 6, runtimeId: 'runtime-1', path: '/' })
  await relay.handle({ type: 'ws_close', sid: 6 })
  await connecting
  await Bun.sleep(50)
  expect(sent.filter((frame) => frame.sid === 6 && frame.type === 'ws_open')).toEqual([])
})

test('closes a stream whose queue before opening overflows', async () => {
  const { relay, nextOf } = relayTo(spyriaAgent, { maximumQueuedMessages: 2 })
  await relay.handle({ type: 'ws_connect', sid: 4, runtimeId: 'runtime-1', path: '/' })
  for (const data of ['one', 'two', 'three']) await relay.handle({ type: 'ws_msg', sid: 4, data })
  expect(await nextOf('ws_close')).toMatchObject({ type: 'ws_close', sid: 4 })
})

const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const accessToken = 'sk-ant-oat01-FAKEACCESS-current-0000000000'
const refreshToken = 'opaque-refresh-value-123456'
const conversationId = '0b6f2c1e-1f8a-4c55-9f0e-6f1d2a3b4c5d'
const tokenServer = Bun.serve({
  port: 0,
  fetch: (request, server) =>
    server.upgrade(request)
      ? undefined
      : Response.json({
          path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
          ...(new URL(request.url).pathname === '/api/workspace/media' && {
            content: Buffer.concat([
              pngHeader,
              Buffer.from(
                new URL(request.url).searchParams.get('path') === 'stolen.png' ? `x${refreshToken}x` : 'pixels',
              ),
            ]).toString('base64'),
          }),
          output: `{"accessToken":"${accessToken}","refreshToken":"${refreshToken}"} and sk-ant-ort01-OTHER_refresh-9`,
        }),
  websocket: {
    open: (socket) => {
      socket.send(JSON.stringify({ kind: 'ObservationEvent', content: `cat said ${accessToken} ${refreshToken}` }))
    },
    message: () => {},
  },
})
afterAll(() => tokenServer.stop(true))

const personalRelay = () => relayTo(tokenServer, { personal: { secrets: () => [refreshToken] } })

test('a personal host answers a path it does not relay with an error, and closes such a WebSocket', async () => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({
    type: 'http',
    sid: 1,
    runtimeId: 'runtime-1',
    method: 'POST',
    path: '/api/bash/execute_bash_command',
  })
  expect(await nextOf('http_res')).toEqual({
    type: 'http_res',
    sid: 1,
    error: 'refused: this path is not relayed by a personal host',
  })
  await relay.handle({ type: 'ws_connect', sid: 2, runtimeId: 'runtime-1', path: '/sockets/bash-events' })
  expect(await nextOf('ws_close')).toMatchObject({
    type: 'ws_close',
    sid: 2,
    error: expect.stringContaining('refused'),
  })
})

test('a personal host redacts token formats and the current token values in http_res bodies, keeping valid JSON', async () => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({ type: 'http', sid: 4, runtimeId: 'runtime-1', method: 'GET', path: '/ready' })
  expect(JSON.parse(String((await nextOf('http_res'))?.body))).toEqual({
    path: '/ready',
    output: '{"accessToken":"[redacted]","refreshToken":"[redacted]"} and [redacted]',
  })
})

test('a personal host streams the events WebSocket with the tokens redacted, keeping valid JSON', async () => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({ type: 'ws_connect', sid: 7, runtimeId: 'runtime-1', path: `/sockets/events/${conversationId}` })
  expect(await nextOf('ws_open')).toEqual({ type: 'ws_open', sid: 7 })
  expect(JSON.parse(String((await nextOf('ws_msg'))?.data))).toEqual({
    kind: 'ObservationEvent',
    content: 'cat said [redacted] [redacted]',
  })
  await relay.handle({ type: 'ws_close', sid: 7 })
})

test('a workspace host forwards any path and leaves bodies untouched', async () => {
  const { relay, sent } = relayTo(tokenServer)
  await relay.handle({ type: 'http', sid: 7, runtimeId: 'runtime-1', method: 'GET', path: '/api/file/download?path=x' })
  await waitFor(() => sent.length > 0)
  expect(String(sent[0]?.body)).toContain(accessToken)
})

test('a frame over the limit is never sent: an HTTP answer becomes an error under the limit, any other frame is dropped', () => {
  const body = 'x'.repeat(1000)
  expect(JSON.parse(String(frameTextOf({ type: 'http_res', sid: 7, status: 200, body }, 2000)))).toMatchObject({
    sid: 7,
    body,
  })
  const refused = String(frameTextOf({ type: 'http_res', sid: 7, status: 200, body: body.repeat(3) }, 2000))
  expect(JSON.parse(refused)).toEqual({ type: 'http_res', sid: 7, error: 'The response is too large to relay' })
  expect(Buffer.byteLength(refused)).toBeLessThan(2000)
  expect(frameTextOf({ type: 'gw_req', sid: 8, body: 'é'.repeat(900) }, 2000)).toBeDefined()
  expect(frameTextOf({ type: 'gw_req', sid: 8, body: 'é'.repeat(1100) }, 2000)).toBeUndefined()
})

test('a personal host relays a workspace file whose bytes hold no secret, and refuses one that hides a token behind media bytes', async () => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({
    type: 'http',
    sid: 6,
    runtimeId: 'runtime-1',
    method: 'GET',
    path: '/api/workspace/media?path=chart.png',
  })
  const relayed = JSON.parse(String((await nextOf('http_res'))?.body))
  expect(Buffer.from(relayed.content, 'base64')).toEqual(Buffer.concat([pngHeader, Buffer.from('pixels')]))
  await relay.handle({
    type: 'http',
    sid: 7,
    runtimeId: 'runtime-1',
    method: 'GET',
    path: '/api/workspace/media?path=stolen.png',
  })
  expect(await nextOf('http_res')).toEqual({ type: 'http_res', sid: 7, error: 'refused: this file holds a secret' })
})

const binaryBody = Buffer.from(Array.from({ length: relayChunkBytes * 2 + 7 }, (_, index) => (index * 31) % 256))
const binaryAgent = Bun.serve({
  port: 0,
  fetch: (request, server) => {
    if (server.upgrade(request)) return undefined
    if (request.method === 'GET') return new Response(binaryBody, { headers: { 'content-type': 'image/png' } })
    return request.text().then((text) => new Response(`received ${text.length} ${text.slice(-3)}`))
  },
  websocket: {
    message: (socket, message) => {
      const [count, size] = String(message).split(' ').map(Number)
      for (let index = 0; index < (count ?? 0); index++) socket.send(`${index}:${'x'.repeat(size ?? 0)}`)
    },
  },
})
afterAll(() => binaryAgent.stop(true))

test('a chunked request reaches the runtime whole, and its answer comes back in base64 chunks, byte for byte', async () => {
  const { relay, sent, nextOf } = relayTo(binaryAgent, { isBackedUp: () => true })
  const requestBody = `${'é'.repeat(relayChunkBytes)}end`
  await relay.handle({ type: 'http', sid: 1, runtimeId: 'runtime-1', method: 'POST', path: '/upload', chunked: true })
  for (const frame of bodyFramesOf(1, Buffer.from(requestBody))) await relay.handle(frame)
  expect(await nextOf('http_res')).toMatchObject({ sid: 1, status: 200, chunked: true })
  await nextOf('http_end')
  const answered = sent.filter((frame) => frame.type === 'http_body').map((frame) => String(frame.data))
  expect(Buffer.concat(answered.map((data) => Buffer.from(data, 'base64'))).toString()).toBe(
    `received ${requestBody.length} end`,
  )

  sent.length = 0
  await relay.handle({ type: 'http', sid: 2, runtimeId: 'runtime-1', method: 'GET', path: '/chart.png', chunked: true })
  for (const frame of bodyFramesOf(2, new Uint8Array())) await relay.handle(frame)
  expect(await nextOf('http_res')).toMatchObject({ sid: 2, status: 200, chunked: true })
  await nextOf('http_end')
  const chunks = sent
    .filter((frame) => frame.type === 'http_body')
    .map((frame) => Buffer.from(String(frame.data), 'base64'))
  expect(chunks.map((chunk) => chunk.length)).toEqual([relayChunkBytes, relayChunkBytes, 7])
  expect(Buffer.concat(chunks).equals(binaryBody)).toBe(true)
})

test('a stream with credit holds what the server has not acknowledged, whatever the socket buffers, and closes alone once it holds too much', async () => {
  const { relay, sent, nextOf } = relayTo(binaryAgent, { isBackedUp: () => true, maximumHeldBytes: 2_500 })
  await relay.handle({ type: 'ws_connect', sid: 5, runtimeId: 'runtime-1', path: '/events', creditBytes: 1_000 })
  await relay.handle({ type: 'ws_connect', sid: 6, runtimeId: 'runtime-1', path: '/events', creditBytes: 1_000 })
  await nextOf('ws_open')
  await nextOf('ws_open')
  await relay.handle({ type: 'ws_msg', sid: 5, data: '4 400' })
  await waitFor(() => sent.filter((frame) => frame.type === 'ws_msg').length >= 2)
  await Bun.sleep(50)
  const relayedOf = (sid: number) =>
    sent
      .filter((frame) => frame.type === 'ws_msg' && frame.sid === sid)
      .map((frame) => String(frame.data).split(':')[0])
  expect(relayedOf(5)).toEqual(['0', '1'])
  await relay.handle({ type: 'ws_ack', sid: 5, bytes: 804 })
  await waitFor(() => relayedOf(5).length === 4)
  expect(relayedOf(5)).toEqual(['0', '1', '2', '3'])

  await relay.handle({ type: 'ws_msg', sid: 6, data: '10 400' })
  expect(await nextOf('ws_close')).toEqual({ type: 'ws_close', sid: 6 })
  expect(sent.some((frame) => frame.type === 'ws_close' && frame.sid === 5)).toBe(false)
  await relay.handle({ type: 'ws_msg', sid: 5, data: '1 10' })
  await waitFor(() => relayedOf(5).length === 5)
  expect(relayedOf(5).at(-1)).toBe('0')
})

const browserKey = 'f'.repeat(32)
const browserRelay = () => {
  const sent: Record<string, unknown>[] = []
  const written: string[] = []
  const opened: string[] = []
  let listener: BrowserStreamListener | undefined
  const attached = Promise.withResolvers<void>()
  const relay = createRelay({
    addressOf: async () => {
      throw new Error('a browser stream never reaches the runtime')
    },
    send: (frame) => sent.push(frame),
    openBrowser: async (runtimeId, key, browserListener) => {
      opened.push(`${runtimeId}/${key}`)
      listener = browserListener
      browserListener.onLine('{"type":"ready"}')
      await attached.promise
      return { send: (line) => written.push(line), close: () => browserListener.onClose() }
    },
  })
  return {
    relay,
    sent,
    written,
    opened,
    attach: attached.resolve,
    output: (line: string) => listener?.onLine(line),
    nextOf: (type: string) => nextFrameOf(sent, type),
  }
}

test("a browser stream reaches the browser's controller, not the runtime, keeping order both ways", async () => {
  const { relay, written, opened, attach, output, nextOf } = browserRelay()
  const connecting = relay.handle({ type: 'ws_connect', sid: 20, runtimeId: 'runtime-1', browserKey })
  await relay.handle({ type: 'ws_msg', sid: 20, data: '{"type":"settings"}' })
  attach()
  await connecting
  expect(opened).toEqual([`runtime-1/${browserKey}`])
  expect(await nextOf('ws_open')).toEqual({ type: 'ws_open', sid: 20 })
  expect(await nextOf('ws_msg')).toEqual({ type: 'ws_msg', sid: 20, data: '{"type":"ready"}' })
  expect(written).toEqual(['{"type":"settings"}'])
  output('{"type":"page"}')
  expect(await nextOf('ws_msg')).toEqual({ type: 'ws_msg', sid: 20, data: '{"type":"page"}' })
  await relay.handle({ type: 'ws_close', sid: 20 })
  expect(await nextOf('ws_close')).toEqual({ type: 'ws_close', sid: 20 })
})

test('a browser stream with an invalid key, or on a host without browsers, closes at once', async () => {
  const { relay, opened, nextOf } = browserRelay()
  await relay.handle({ type: 'ws_connect', sid: 21, runtimeId: 'runtime-1', browserKey: '../x' })
  expect(await nextOf('ws_close')).toEqual({ type: 'ws_close', sid: 21, error: 'refused: invalid browser key' })
  expect(opened).toEqual([])
  const withoutBrowsers = relayTo(spyriaAgent)
  await withoutBrowsers.relay.handle({ type: 'ws_connect', sid: 22, runtimeId: 'runtime-1', browserKey })
  expect(await withoutBrowsers.nextOf('ws_close')).toMatchObject({ sid: 22, error: 'refused: invalid browser key' })
})

const fileId = 'c'.repeat(32)
const fileRelay = (content: Buffer) => {
  const sent: Record<string, unknown>[] = []
  const reads: string[] = []
  let isAborted = false
  const relay = createRelay({
    addressOf: async () => '',
    send: (frame) => sent.push(frame),
    readBrowserFile: async (runtimeId, key, file, signal) => {
      reads.push(`${runtimeId}/${key}/${file}`)
      signal.addEventListener('abort', () => {
        isAborted = true
      })
      return (async function* () {
        for (let offset = 0; offset < content.length; offset += 100_000)
          yield content.subarray(offset, offset + 100_000)
      })()
    },
  })
  const received = () =>
    Buffer.concat(sent.filter(({ type }) => type === 'ws_msg').map(({ data }) => Buffer.from(String(data), 'base64')))
  return { relay, sent, reads, received, isAborted: () => isAborted }
}

test("a browser's file streams to Spyria only as fast as Spyria acknowledges it, whole and in order", async () => {
  const content = Buffer.from(Array.from({ length: 2_000_000 }, (_, index) => index % 253))
  const { relay, sent, reads, received } = fileRelay(content)
  void relay.handle({ type: 'ws_connect', sid: 30, runtimeId: 'runtime-1', browserKey, fileId, creditBytes: 600_000 })
  await waitFor(() => sent.filter(({ type }) => type === 'ws_msg').length > 0)
  await Bun.sleep(50)
  expect(reads).toEqual([`runtime-1/${browserKey}/${fileId}`])
  const unacknowledged = () =>
    sent.filter(({ type }) => type === 'ws_msg').reduce((total, { data }) => total + String(data).length, 0)
  expect(unacknowledged()).toBeLessThanOrEqual(600_000)
  expect(sent.some(({ type }) => type === 'ws_close')).toBe(false)
  let acknowledged = 0
  while (!sent.some(({ type }) => type === 'ws_close')) {
    const bytes = unacknowledged() - acknowledged
    acknowledged += bytes
    await relay.handle({ type: 'ws_ack', sid: 30, bytes })
    await Bun.sleep(5)
  }
  expect(received()).toEqual(content)
  expect(sent.at(-1)).toEqual({ type: 'ws_close', sid: 30 })
})

test("closing a browser's file stream stops reading the file, and an invalid key never reads it", async () => {
  const { relay, sent, isAborted } = fileRelay(Buffer.alloc(3_000_000))
  void relay.handle({ type: 'ws_connect', sid: 31, runtimeId: 'runtime-1', browserKey, fileId, creditBytes: 300_000 })
  await waitFor(() => sent.some(({ type }) => type === 'ws_msg'))
  await relay.handle({ type: 'ws_close', sid: 31 })
  await waitFor(isAborted)
  expect(isAborted()).toBe(true)
  const refused = fileRelay(Buffer.alloc(10))
  await refused.relay.handle({ type: 'ws_connect', sid: 32, runtimeId: 'runtime-1', browserKey: '../x', fileId })
  expect(refused.reads).toEqual([])
  expect(refused.sent).toEqual([{ type: 'ws_close', sid: 32, error: 'refused: invalid browser key' }])
})
