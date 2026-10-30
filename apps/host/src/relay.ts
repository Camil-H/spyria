import { Refused, relayUrlOf } from './commands.ts'
import { isAllowedOnPersonalHost, isMediaHoldingSecret, redacted } from './personal.ts'
import { contextOf, traceHeadersOf, withSpan } from './telemetry.ts'

export type Frame = { type: string; sid?: unknown; [field: string]: unknown }
type Stream = {
  socket: WebSocket
  queue: string[] | null
  creditBytes?: number
  unacknowledgedBytes: number
  held: string[]
  heldBytes: number
  isRuntimeClosed: boolean
}
type IncomingRequest = { frame: Frame; parts: Buffer[]; size: number }

const maximumTimeoutMilliseconds = 120_000
const timeoutOf = (requested: unknown) =>
  typeof requested === 'number' && requested > 0
    ? Math.min(requested, maximumTimeoutMilliseconds)
    : maximumTimeoutMilliseconds

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const relayVersion = 3
export const relayChunkBytes = 256 * 1024
const maximumRelayedBodyBytes = 256 * 1024 * 1024
const maximumHeldStreamBytes = 8 * 1024 * 1024
export const maximumFrameBytes = 64 * 1024 * 1024
const tooLarge = 'The response is too large to relay'
export const frameTextOf = (frame: Frame, maximumBytes = maximumFrameBytes) => {
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text) <= maximumBytes) return text
  if (frame.type === 'http_res') return JSON.stringify({ type: 'http_res', sid: frame.sid, error: tooLarge })
  return undefined
}

export const bodyFramesOf = (sid: number, body: Uint8Array) => {
  const frames: Frame[] = []
  for (let offset = 0; offset < body.length; offset += relayChunkBytes)
    frames.push({
      type: 'http_body',
      sid,
      data: Buffer.from(body.subarray(offset, offset + relayChunkBytes)).toString('base64'),
    })
  return [...frames, { type: 'http_end', sid }]
}

export const createRelay = ({
  addressOf,
  send,
  isBackedUp = () => false,
  maximumQueuedMessages = 256,
  maximumHeldBytes = maximumHeldStreamBytes,
  personal,
}: {
  addressOf: (runtimeId: string) => Promise<string>
  send: (frame: Frame) => void
  isBackedUp?: () => boolean
  maximumQueuedMessages?: number
  maximumHeldBytes?: number
  personal?: { secrets: () => readonly string[] }
}) => {
  const streams = new Map<number, Stream>()
  const incomingRequests = new Map<number, IncomingRequest>()
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
  const forwardedBytes = (bytes: Buffer) => {
    if (!personal) return bytes
    const text = bytes.toString('utf8')
    const redactedText = forwarded(text)
    return redactedText === text ? bytes : Buffer.from(redactedText)
  }
  const relayHttp = (sid: number, frame: Frame) =>
    withSpan(
      `host http ${String(frame.method)}`,
      { 'http.request.method': String(frame.method) },
      () => relayHttpInSpan(sid, frame),
      contextOf(frame),
    )
  const answer = (sid: number, frame: Frame, response: Response, body: Buffer) => {
    const head = { type: 'http_res', sid, status: response.status, headers: Object.fromEntries(response.headers) }
    if (frame.chunked !== true) return send({ ...head, body: forwarded(body.toString('utf8')) })
    const relayed = forwardedBytes(body)
    if (relayed.length > maximumRelayedBodyBytes) return send({ type: 'http_res', sid, error: tooLarge })
    send({ ...head, chunked: true })
    for (const bodyFrame of bodyFramesOf(sid, relayed)) send(bodyFrame)
  }
  const relayHttpInSpan = async (sid: number, frame: Frame) => {
    try {
      const response = await fetch(await urlOf(frame, String(frame.method)), {
        method: String(frame.method),
        headers: { ...(frame.headers as Record<string, string> | undefined), ...traceHeadersOf() },
        body: typeof frame.body === 'string' ? frame.body : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutOf(frame.timeoutMilliseconds)),
      })
      const body = Buffer.from(await response.arrayBuffer())
      if (personal && isMediaHoldingSecret(String(frame.path), body.toString('utf8'), personal.secrets()))
        return send({ type: 'http_res', sid, error: 'refused: this file holds a secret' })
      answer(sid, frame, response, body)
    } catch (error) {
      send({ type: 'http_res', sid, error: messageOf(error) })
    }
  }
  const receiveHttp = (sid: number, frame: Frame) => {
    if (frame.chunked !== true) return relayHttp(sid, frame)
    incomingRequests.set(sid, { frame, parts: [], size: 0 })
  }
  const receiveBody = (sid: number, data: string) => {
    const request = incomingRequests.get(sid)
    if (!request) return
    const part = Buffer.from(data, 'base64')
    request.size += part.length
    request.parts.push(part)
    if (request.size <= maximumRelayedBodyBytes) return
    incomingRequests.delete(sid)
    send({ type: 'http_res', sid, error: 'The request is too large to relay' })
  }
  const receiveEnd = (sid: number) => {
    const request = incomingRequests.get(sid)
    if (!request) return
    incomingRequests.delete(sid)
    const body = request.parts.length > 0 ? Buffer.concat(request.parts).toString('utf8') : undefined
    return relayHttp(sid, { ...request.frame, body })
  }
  const sendCounted = (sid: number, stream: Stream, data: string) => {
    stream.unacknowledgedBytes += Buffer.byteLength(data)
    send({ type: 'ws_msg', sid, data })
  }
  const hasCreditFor = (stream: Stream, bytes: number) =>
    stream.unacknowledgedBytes < (stream.creditBytes ?? 0) / 2 ||
    stream.unacknowledgedBytes + bytes <= (stream.creditBytes ?? 0)
  const relayFromRuntime = (sid: number, stream: Stream, data: string) => {
    if (stream.creditBytes === undefined) {
      if (isBackedUp()) return closeStream(sid)
      return send({ type: 'ws_msg', sid, data })
    }
    const bytes = Buffer.byteLength(data)
    if (stream.held.length === 0 && hasCreditFor(stream, bytes)) return sendCounted(sid, stream, data)
    stream.held.push(data)
    stream.heldBytes += bytes
    if (stream.heldBytes > maximumHeldBytes) closeStream(sid)
  }
  const acknowledge = (sid: number, bytes: unknown) => {
    const stream = streams.get(sid)
    if (!stream || typeof bytes !== 'number') return
    stream.unacknowledgedBytes = Math.max(0, stream.unacknowledgedBytes - bytes)
    while (stream.held.length > 0 && hasCreditFor(stream, Buffer.byteLength(stream.held[0] ?? ''))) {
      const data = stream.held.shift() ?? ''
      stream.heldBytes -= Buffer.byteLength(data)
      sendCounted(sid, stream, data)
    }
    if (stream.isRuntimeClosed && stream.held.length === 0) closeStream(sid)
  }
  const openStream = async (sid: number, frame: Frame) => {
    try {
      const url = await urlOf(frame, 'WS')
      url.protocol = 'ws:'
      const stream: Stream = {
        socket: new WebSocket(url),
        queue: [],
        creditBytes: typeof frame.creditBytes === 'number' && frame.creditBytes > 0 ? frame.creditBytes : undefined,
        unacknowledgedBytes: 0,
        held: [],
        heldBytes: 0,
        isRuntimeClosed: false,
      }
      streams.set(sid, stream)
      stream.socket.onopen = () => {
        send({ type: 'ws_open', sid })
        for (const data of stream.queue ?? []) stream.socket.send(data)
        stream.queue = null
      }
      stream.socket.onmessage = (message) => relayFromRuntime(sid, stream, forwarded(String(message.data)))
      stream.socket.onclose = () => {
        stream.isRuntimeClosed = true
        if (streams.get(sid) === stream && stream.held.length === 0) closeStream(sid)
      }
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
      if (frame.type === 'http') return receiveHttp(sid, frame)
      if (frame.type === 'http_body') return receiveBody(sid, String(frame.data))
      if (frame.type === 'http_end') return receiveEnd(sid)
      if (frame.type === 'ws_connect') return openStream(sid, frame)
      if (frame.type === 'ws_msg') return forward(sid, String(frame.data))
      if (frame.type === 'ws_ack') return acknowledge(sid, frame.bytes)
      if (frame.type === 'ws_close') return closeStream(sid)
    },
    closeAll: () => {
      incomingRequests.clear()
      for (const sid of [...streams.keys()]) closeStream(sid)
    },
  }
}
