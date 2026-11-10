import { log } from '@spyria/kernel'
import type { Server } from 'bun'
import type { Context } from 'hono'
import type { WSContext, WSEvents } from 'hono/ws'

export const zeroPathPrefix = '/zero'
const hopByHopHeaders = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]
const requestOnlyHeaders = ['host', 'content-length', 'accept-encoding']
const bodylessMethods = ['GET', 'HEAD']
const maximumCloseReasonBytes = 123
const unreachableStatus = 502
const upstreamOpenTimeoutMilliseconds = 5000

type Relayed = string | ArrayBuffer | Uint8Array<ArrayBuffer>
type UpstreamClosing = { code: number; reason: string }
type HonoSocketData = { events: WSEvents; url: URL; protocol: string }

const withoutHeaders = (headers: Headers, dropped: string[]) => {
  const kept = new Headers(headers)
  for (const name of dropped) kept.delete(name)
  return kept
}

const isSendableCloseCode = (code: number) =>
  code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999)

const closeLike = (socket: { close: (code?: number, reason?: string) => void }, { code, reason }: UpstreamClosing) =>
  isSendableCloseCode(code)
    ? socket.close(code, Buffer.from(reason).subarray(0, maximumCloseReasonBytes).toString())
    : socket.close()

const openUpstreamSocket = (url: URL, protocols: string[]) =>
  new Promise<WebSocket | undefined>((resolve) => {
    const upstream = new WebSocket(url, protocols)
    const giveUp = setTimeout(() => {
      upstream.close()
      resolve(undefined)
    }, upstreamOpenTimeoutMilliseconds)
    upstream.onopen = () => {
      clearTimeout(giveUp)
      resolve(upstream)
    }
    upstream.onerror = () => resolve(undefined)
    upstream.onclose = () => resolve(undefined)
  })

const bridgeOf = (upstream: WebSocket): WSEvents => {
  let downstream: WSContext | undefined
  const held: Relayed[] = []
  let upstreamClosing: UpstreamClosing | undefined
  upstream.onmessage = (event) => (downstream ? downstream.send(event.data) : held.push(event.data))
  upstream.onclose = (event) => {
    upstreamClosing = { code: event.code, reason: event.reason }
    if (downstream) closeLike(downstream, upstreamClosing)
  }
  return {
    onOpen: (_, socket) => {
      downstream = socket
      for (const message of held) socket.send(message)
      held.length = 0
      if (upstreamClosing) closeLike(socket, upstreamClosing)
    },
    onMessage: (event) => upstream.send(event.data as Relayed),
    onClose: (event) => {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
        closeLike(upstream, { code: event.code, reason: event.reason })
    },
  }
}

const upstreamUrlOf = (request: Request, zeroUrl: string) => {
  const { pathname, search } = new URL(request.url)
  const url = new URL(zeroUrl)
  url.pathname = pathname.slice(zeroPathPrefix.length) || '/'
  url.search = search
  return url
}

const unreachable = (context: Context, error: unknown) => {
  log.warn({ event: 'zero.unreachable', body: 'zero-cache did not answer a forwarded request', error })
  return context.text('The sync service is unreachable', unreachableStatus)
}

const forwardWebSocket = async (context: Context, url: URL) => {
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const protocols = (context.req.header('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)
  const upstream = await openUpstreamSocket(url, protocols)
  if (!upstream) return unreachable(context, new Error('The WebSocket to zero-cache did not open'))
  const server = context.env as Server<HonoSocketData>
  const data: HonoSocketData = {
    events: bridgeOf(upstream),
    url: new URL(context.req.url),
    protocol: upstream.protocol,
  }
  const upgraded = server.upgrade(context.req.raw, {
    headers: upstream.protocol ? { 'sec-websocket-protocol': upstream.protocol } : undefined,
    data,
  })
  if (!upgraded) {
    upstream.close()
    return context.text('The WebSocket upgrade failed', 400)
  }
  return new Response(null)
}

const forwardHttp = async (context: Context, url: URL) => {
  const request = context.req.raw
  const headers = withoutHeaders(request.headers, [...hopByHopHeaders, ...requestOnlyHeaders])
  headers.set('accept-encoding', 'identity')
  const response = await fetch(url, {
    method: request.method,
    headers,
    body: bodylessMethods.includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  }).catch((error: unknown) => error)
  if (!(response instanceof Response)) return unreachable(context, response)
  return new Response(response.body, {
    status: response.status,
    headers: withoutHeaders(response.headers, hopByHopHeaders),
  })
}

export const createZeroForwarding = (zeroUrl: string) => (context: Context) => {
  const url = upstreamUrlOf(context.req.raw, zeroUrl)
  const isUpgrade = context.req.header('upgrade')?.toLowerCase() === 'websocket'
  return isUpgrade ? forwardWebSocket(context, url) : forwardHttp(context, url)
}
