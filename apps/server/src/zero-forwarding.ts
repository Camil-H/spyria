import { log } from '@spyria/kernel'
import type { Server } from 'bun'
import type { Context } from 'hono'
import type { WSEvents } from 'hono/ws'

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
const unreachableClosing: UpstreamClosing = { code: 1011, reason: 'The sync service is unreachable' }

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

const logUnreachable = (error: unknown) =>
  log.warn({ event: 'zero.unreachable', body: 'zero-cache did not answer a forwarded request', error })

const bridgeTo = (url: URL, protocols: string[]): WSEvents => {
  let upstream: WebSocket | undefined
  const heldForUpstream: Relayed[] = []
  let hasBrowserLeft = false
  return {
    onOpen: (_, downstream) => {
      const opening = new WebSocket(url, protocols)
      upstream = opening
      let hasOpened = false
      const giveUp = setTimeout(() => opening.close(), upstreamOpenTimeoutMilliseconds)
      opening.onopen = () => {
        clearTimeout(giveUp)
        hasOpened = true
        for (const message of heldForUpstream) opening.send(message)
        heldForUpstream.length = 0
      }
      opening.onmessage = (event) => downstream.send(event.data)
      opening.onclose = (event) => {
        clearTimeout(giveUp)
        if (hasBrowserLeft) return
        if (hasOpened) return closeLike(downstream, { code: event.code, reason: event.reason })
        logUnreachable(new Error('The WebSocket to zero-cache did not open'))
        closeLike(downstream, unreachableClosing)
      }
    },
    onMessage: (event) =>
      upstream?.readyState === WebSocket.OPEN
        ? upstream.send(event.data as Relayed)
        : heldForUpstream.push(event.data as Relayed),
    onClose: (event) => {
      hasBrowserLeft = true
      heldForUpstream.length = 0
      if (upstream?.readyState === WebSocket.OPEN || upstream?.readyState === WebSocket.CONNECTING)
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
  logUnreachable(error)
  return context.text(unreachableClosing.reason, unreachableStatus)
}

const forwardWebSocket = (context: Context, url: URL) => {
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const protocols = (context.req.header('sec-websocket-protocol') ?? '')
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean)
  const [protocol = ''] = protocols
  const server = context.env as Server<HonoSocketData>
  const data: HonoSocketData = { events: bridgeTo(url, protocols), url: new URL(context.req.url), protocol }
  const upgraded = server.upgrade(context.req.raw, {
    headers: protocol ? { 'sec-websocket-protocol': protocol } : undefined,
    data,
  })
  return upgraded ? new Response(null) : context.text('The WebSocket upgrade failed', 400)
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

export const isWebSocketUpgrade = (context: Context) => context.req.header('upgrade')?.toLowerCase() === 'websocket'

export const createZeroForwarding = (zeroUrl: string) => (context: Context) => {
  const url = upstreamUrlOf(context.req.raw, zeroUrl)
  return isWebSocketUpgrade(context) ? forwardWebSocket(context, url) : forwardHttp(context, url)
}
