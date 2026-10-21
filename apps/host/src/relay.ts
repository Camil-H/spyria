import { Refused, relayUrlOf } from './commands.ts'
import { isAllowedOnPersonalHost, redacted } from './personal.ts'
import { contextOf, traceHeadersOf, withSpan } from './telemetry.ts'

export type Frame = { type: string; sid?: unknown; [field: string]: unknown }
type Stream = { socket: WebSocket; queue: string[] | null }

const maximumTimeoutMilliseconds = 120_000
const timeoutOf = (requested: unknown) =>
  typeof requested === 'number' && requested > 0
    ? Math.min(requested, maximumTimeoutMilliseconds)
    : maximumTimeoutMilliseconds

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const maximumFrameBytes = 64 * 1024 * 1024
export const frameTextOf = (frame: Frame, maximumBytes = maximumFrameBytes) => {
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text) <= maximumBytes) return text
  if (frame.type === 'http_res')
    return JSON.stringify({ type: 'http_res', sid: frame.sid, error: 'The response is too large to relay' })
  return undefined
}

export const createRelay = ({
  addressOf,
  send,
  isBackedUp = () => false,
  maximumQueuedMessages = 256,
  personal,
}: {
  addressOf: (runtimeId: string) => Promise<string>
  send: (frame: Frame) => void
  isBackedUp?: () => boolean
  maximumQueuedMessages?: number
  personal?: { secrets: () => readonly string[] }
}) => {
  const streams = new Map<number, Stream>()
  const closeStream = (sid: number) => {
    const stream = streams.get(sid)
    if (!stream) return
    streams.delete(sid)
    stream.socket.close()
    send({ type: 'ws_close', sid })
  }
  const urlOf = async (frame: Frame, method: string) => {
    if (personal && !isAllowedOnPersonalHost(method, String(frame.path)))
      throw new Refused('this path is not relayed by a personal host')
    return relayUrlOf(await addressOf(String(frame.runtimeId)), String(frame.path))
  }
  const forwarded = (text: string) => (personal ? redacted(text, personal.secrets()) : text)
  const relayHttp = (sid: number, frame: Frame) =>
    withSpan(
      `host http ${String(frame.method)}`,
      { 'http.request.method': String(frame.method) },
      () => relayHttpInSpan(sid, frame),
      contextOf(frame),
    )
  const relayHttpInSpan = async (sid: number, frame: Frame) => {
    try {
      const response = await fetch(await urlOf(frame, String(frame.method)), {
        method: String(frame.method),
        headers: { ...(frame.headers as Record<string, string> | undefined), ...traceHeadersOf() },
        body: typeof frame.body === 'string' ? frame.body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutOf(frame.timeoutMilliseconds)),
      })
      send({
        type: 'http_res',
        sid,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: forwarded(await response.text()),
      })
    } catch (error) {
      send({ type: 'http_res', sid, error: messageOf(error) })
    }
  }
  const openStream = async (sid: number, frame: Frame) => {
    try {
      const url = await urlOf(frame, 'WS')
      url.protocol = 'ws:'
      const stream: Stream = { socket: new WebSocket(url), queue: [] }
      streams.set(sid, stream)
      stream.socket.onopen = () => {
        send({ type: 'ws_open', sid })
        for (const data of stream.queue ?? []) stream.socket.send(data)
        stream.queue = null
      }
      stream.socket.onmessage = (message) => {
        if (isBackedUp()) return closeStream(sid)
        send({ type: 'ws_msg', sid, data: forwarded(String(message.data)) })
      }
      stream.socket.onclose = () => streams.get(sid) === stream && closeStream(sid)
    } catch (error) {
      send({ type: 'ws_close', sid, error: messageOf(error) })
    }
  }
  const forward = (sid: number, data: string) => {
    const stream = streams.get(sid)
    if (!stream) return
    if (!stream.queue) return stream.socket.send(data)
    if (stream.queue.length >= maximumQueuedMessages) return closeStream(sid)
    stream.queue.push(data)
  }
  return {
    handle: async (frame: Frame) => {
      const sid = Number(frame.sid)
      if (frame.type === 'http') return relayHttp(sid, frame)
      if (frame.type === 'ws_connect') return openStream(sid, frame)
      if (frame.type === 'ws_msg') return forward(sid, String(frame.data))
      if (frame.type === 'ws_close') return closeStream(sid)
    },
    closeAll: () => {
      for (const sid of [...streams.keys()]) closeStream(sid)
    },
  }
}
