import { afterAll, expect, test } from 'bun:test'
import { createApp } from './app.ts'
import { serverWebSocket } from './runtime-hosts/gateway.ts'
import { acme, alice, issueTestSession, openSharedTestApp, testAuthSettings } from './testing/testing.ts'

const { database } = await openSharedTestApp()
const fakeZeroCache = Bun.serve({
  port: 0,
  fetch: (request, server) =>
    server.upgrade(request, {
      headers: { 'sec-websocket-protocol': request.headers.get('sec-websocket-protocol') ?? '' },
      data: undefined,
    })
      ? undefined
      : new Response('not a socket', { status: 400 }),
  websocket: {
    message: (socket, message) => {
      socket.send(message)
    },
  },
})
const app = createApp({ database, ...testAuthSettings, zeroUrl: fakeZeroCache.url.origin })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: serverWebSocket })
afterAll(() => {
  void server.stop(true)
  void fakeZeroCache.stop(true)
})

const zeroProtocolOf = (authToken: string) =>
  encodeURIComponent(btoa(JSON.stringify({ initConnectionMessage: ['initConnection', {}], authToken })))
const openZeroSocket = (authToken: string) =>
  new Promise<{ socket: WebSocket; closed: Promise<CloseEvent>; echoed: Promise<string> }>((resolve, reject) => {
    const socket = new WebSocket(`${server.url.origin.replace('http', 'ws')}/zero/sync/v51/connect`, [
      zeroProtocolOf(authToken),
    ])
    const closed = new Promise<CloseEvent>((resolveClose) => {
      socket.onclose = resolveClose
    })
    const echoed = new Promise<string>((resolveEcho) => {
      socket.onmessage = (event) => resolveEcho(String(event.data))
    })
    socket.onopen = () => resolve({ socket, closed, echoed })
    socket.onerror = () => reject(new Error('The Zero socket did not open'))
  })

test('a Zero socket forwarded by the server closes as not signed in once its session ends, and the sockets of other sessions stay open', async () => {
  const ending = await issueTestSession(database, acme, alice)
  const other = await issueTestSession(database, acme, alice)
  const endingSocket = await openZeroSocket(ending.token)
  const otherSocket = await openZeroSocket(other.token)
  endingSocket.socket.send('ready')
  otherSocket.socket.send('ready')
  expect(await Promise.all([endingSocket.echoed, otherSocket.echoed])).toEqual(['ready', 'ready'])
  await database.$client`delete from sessions where workspace_id = ${acme} and id = ${ending.sessionId}`
  const endedClose = await endingSocket.closed
  expect(endedClose.code).toBe(4001)
  expect(otherSocket.socket.readyState).toBe(WebSocket.OPEN)
  otherSocket.socket.close()
})
