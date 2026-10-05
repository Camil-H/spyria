import { afterAll, expect, test } from 'bun:test'
import { createRelay } from './relay.ts'

const agentServer = Bun.serve({
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
afterAll(() => agentServer.stop(true))

const relayCollecting = () => {
  const sent: Record<string, unknown>[] = []
  const relay = createRelay({
    addressOf: async (runtimeId) => {
      if (runtimeId !== 'runtime-1') throw new Error('refused: not a managed runtime')
      return `http://localhost:${agentServer.port}`
    },
    send: (frame) => sent.push(frame),
    maximumQueuedMessages: 2,
  })
  const nextOf = async (type: string) => {
    for (const deadline = Date.now() + 5000; Date.now() < deadline; await Bun.sleep(5)) {
      const index = sent.findIndex((frame) => frame.type === type)
      if (index >= 0) return sent.splice(index, 1)[0]
    }
    throw new Error(`No ${type} frame`)
  }
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
