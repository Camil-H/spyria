import { afterAll, expect, test } from 'bun:test'
import { createRelay, frameTextOf } from './relay.ts'
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

const relayCollecting = () => {
  const sent: Record<string, unknown>[] = []
  const relay = createRelay({
    addressOf: async (runtimeId) => {
      if (runtimeId !== 'runtime-1') throw new Error('refused: not a managed runtime')
      return `http://localhost:${spyriaAgent.port}`
    },
    send: (frame) => sent.push(frame),
    maximumQueuedMessages: 2,
  })
  const nextOf = (type: string) => nextFrameOf(sent, type)
  return { relay, nextOf }
}

test('relays an HTTP call and answers with its status and body', async () => {
  const { relay, nextOf } = relayCollecting()
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
  const { relay, nextOf } = relayCollecting()
  await relay.handle({ type: 'http', sid: 2, runtimeId: 'other', method: 'GET', path: '/' })
  expect(await nextOf('http_res')).toEqual({ type: 'http_res', sid: 2, error: 'refused: not a managed runtime' })
})

test('relays a WebSocket stream both ways and closes it', async () => {
  const { relay, nextOf } = relayCollecting()
  await relay.handle({ type: 'ws_connect', sid: 3, runtimeId: 'runtime-1', path: '/sockets/events/1' })
  await relay.handle({ type: 'ws_msg', sid: 3, data: 'queued before open' })
  expect(await nextOf('ws_open')).toEqual({ type: 'ws_open', sid: 3 })
  expect(await nextOf('ws_msg')).toEqual({ type: 'ws_msg', sid: 3, data: 'echo queued before open' })
  await relay.handle({ type: 'ws_msg', sid: 3, data: 'hello' })
  expect(await nextOf('ws_msg')).toEqual({ type: 'ws_msg', sid: 3, data: 'echo hello' })
  await relay.handle({ type: 'ws_close', sid: 3 })
  expect(await nextOf('ws_close')).toMatchObject({ type: 'ws_close', sid: 3 })
})

test('closes a stream whose queue before opening overflows', async () => {
  const { relay, nextOf } = relayCollecting()
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

const personalRelay = () => {
  const sent: Record<string, unknown>[] = []
  const relay = createRelay({
    addressOf: async () => `http://localhost:${tokenServer.port}`,
    send: (frame) => sent.push(frame),
    personal: { secrets: () => [refreshToken] },
  })
  const nextOf = (type: string) => nextFrameOf(sent, type)
  return { relay, nextOf }
}

test.each([
  ['POST', '/api/bash/execute_bash_command'],
  ['GET', '/api/file/download?path=/home/openhands/.claude/.credentials.json'],
  ['GET', `/api/conversations/${conversationId}/workspace/x`],
  ['GET', '/api/conversations/search'],
  ['POST', `/api/conversations/${conversationId}/../../bash/execute_bash_command`],
  ['DELETE', '/api/conversations'],
  ['POST', `/api/conversations/${conversationId}/switch_llm`],
  ['GET', `/api/conversations/${conversationId}/agent_final_response`],
  ['GET', `/api/conversations/${conversationId}/questions/${conversationId}`],
  ['POST', `/api/conversations/${conversationId}/questions/../../interrupt`],
  ['POST', '/api/workspace/tree'],
  ['GET', '/api/workspace/../conversations'],
  ['GET', '/api/workspace/file?path=../x/y'],
  ['POST', '/api/workspace/push'],
  ['GET', '/api/workspace/merge'],
  ['POST', '/api/workspace/status'],
  ['POST', '/api/workspace/media'],
])('a personal host refuses %s %s', async (method, path) => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({ type: 'http', sid: 1, runtimeId: 'runtime-1', method, path })
  expect(await nextOf('http_res')).toEqual({
    type: 'http_res',
    sid: 1,
    error: 'refused: this path is not relayed by a personal host',
  })
})

test.each([
  '/sockets/bash-events',
  `/sockets/events/${conversationId}?after=1&x=2`,
  `/sockets/events/${conversationId}?resend_mode=all`,
  `/sockets/events/${conversationId}?resend_mode=since&after_timestamp=2026-10-10T10%3A00%3A00.000000`,
])('a personal host refuses the WebSocket %s', async (path) => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({ type: 'ws_connect', sid: 2, runtimeId: 'runtime-1', path })
  expect(await nextOf('ws_close')).toMatchObject({
    type: 'ws_close',
    sid: 2,
    error: expect.stringContaining('refused'),
  })
})

test.each([
  ['GET', '/ready'],
  ['POST', '/api/conversations'],
  ['GET', `/api/conversations/${conversationId}`],
  ['DELETE', `/api/conversations/${conversationId}`],
  ['POST', `/api/conversations/${conversationId}/events`],
  ['POST', `/api/conversations/${conversationId}/interrupt`],
  ['POST', `/api/conversations/${conversationId}/switch_acp_model`],
  ['POST', `/api/conversations/${conversationId}/questions/${conversationId}`],
  ['GET', '/api/workspace/tree?path=src%2Futil'],
  ['GET', '/api/workspace/file?path=README.md'],
  ['GET', '/api/workspace/media?path=out%2Fchart.png'],
  ['GET', '/api/workspace/changes?base=main'],
  ['GET', '/api/workspace/status?base=main'],
  ['POST', '/api/workspace/bundle'],
  ['POST', '/api/workspace/commit'],
  ['POST', '/api/workspace/merge'],
  ['POST', '/api/workspace/pushed'],
])('a personal host forwards %s %s', async (method, path) => {
  const { relay, nextOf } = personalRelay()
  await relay.handle({ type: 'http', sid: 3, runtimeId: 'runtime-1', method, path })
  expect(JSON.parse(String((await nextOf('http_res'))?.body)).path).toBe(path)
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
  for (const [sid, query] of [
    [7, ''],
    [8, 'after=42'],
  ] as const) {
    await relay.handle({
      type: 'ws_connect',
      sid,
      runtimeId: 'runtime-1',
      path: `/sockets/events/${conversationId}${query && `?${query}`}`,
    })
    expect(await nextOf('ws_open')).toEqual({ type: 'ws_open', sid })
    expect(JSON.parse(String((await nextOf('ws_msg'))?.data))).toEqual({
      kind: 'ObservationEvent',
      content: 'cat said [redacted] [redacted]',
    })
    await relay.handle({ type: 'ws_close', sid })
  }
})

test('a workspace host forwards any path and leaves bodies untouched', async () => {
  const sent: Record<string, unknown>[] = []
  const relay = createRelay({
    addressOf: async () => `http://localhost:${tokenServer.port}`,
    send: (frame) => sent.push(frame),
  })
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
