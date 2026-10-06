type Frame = { type: string; sid?: unknown; [field: string]: unknown }
type Pending = { resolveHead: (response: Response) => void; body?: ReadableStreamDefaultController<Uint8Array> }

const encoder = new TextEncoder()
const unreachable = () =>
  Response.json(
    { error: { message: 'The model gateway is unreachable', type: 'gateway_unavailable' } },
    { status: 502 },
  )

export const createModelRelay = ({ send }: { send: (frame: Frame) => boolean }) => {
  const pending = new Map<number, Pending>()
  let nextSid = 1
  const fail = (sid: number) => {
    const stream = pending.get(sid)
    pending.delete(sid)
    stream?.resolveHead(unreachable())
    stream?.body?.error(new Error('The model gateway is unreachable'))
  }
  return {
    fetch: async (request: Request) => {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/v1/')) return new Response('Not found', { status: 404 })
      const sid = nextSid++
      const head = new Promise<Response>((resolveHead) => pending.set(sid, { resolveHead }))
      const frame = {
        type: 'gw_req',
        sid,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      }
      if (!send(frame)) fail(sid)
      return head
    },
    handle: (frame: Frame) => {
      const sid = Number(frame.sid)
      const stream = pending.get(sid)
      if (!stream) return
      if (frame.type === 'gw_head') {
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            stream.body = controller
          },
          cancel: () => {
            pending.delete(sid)
            send({ type: 'gw_cancel', sid })
          },
        })
        stream.resolveHead(
          new Response(body, { status: Number(frame.status), headers: frame.headers as Record<string, string> }),
        )
      }
      if (frame.type === 'gw_chunk') stream.body?.enqueue(encoder.encode(String(frame.data)))
      if (frame.type === 'gw_end') {
        pending.delete(sid)
        stream.body?.close()
      }
      if (frame.type === 'gw_error') fail(sid)
    },
    closeAll: () => {
      for (const sid of [...pending.keys()]) fail(sid)
    },
  }
}
