import { afterEach, expect, test } from 'bun:test'
import { createRelay } from './relay.ts'
import { log, startTelemetry, withSpan } from './telemetry.ts'
import { nextFrameOf } from './testing.ts'

let lines: Record<string, unknown>[] = []
let telemetry: ReturnType<typeof startTelemetry> | undefined
const started = () => {
  lines = []
  telemetry = startTelemetry({ write: (line) => void lines.push(JSON.parse(line)) })
}
afterEach(() => telemetry?.shutdown())

test('a host line carries spyria-host, the active span ids and no secret-looking attribute or query string', async () => {
  started()
  const ids = await withSpan('host command create', {}, async (span) => {
    log.info({
      event: 'host.command',
      body: 'Host command done',
      attributes: {
        'host.command': 'create',
        'url.path': '/h/code?code=1',
        'x-session-api-key': 'key',
        duration_ms: 3,
      },
    })
    return span.spanContext()
  })
  const { timestamp, ...line } = lines[0] ?? {}
  expect(line).toEqual({
    severity: 'INFO',
    body: 'Host command done',
    'event.name': 'host.command',
    trace_id: ids.traceId,
    span_id: ids.spanId,
    'service.name': 'spyria-host',
    'deployment.environment.name': 'development',
    'host.command': 'create',
    'url.path': '/h/code',
    duration_ms: 3,
  })
})

test('the relay continues the frame’s trace and hands its own span to spyria-agent as traceparent', async () => {
  started()
  const received: (string | null)[] = []
  const spyriaAgent = Bun.serve({
    port: 0,
    fetch: (request) => {
      received.push(request.headers.get('traceparent'))
      return new Response('ok')
    },
  })
  const sent: Record<string, unknown>[] = []
  const relay = createRelay({
    addressOf: async () => `http://localhost:${spyriaAgent.port}`,
    send: (frame) => sent.push(frame),
  })
  const traceId = 'a'.repeat(32)
  await relay.handle({
    type: 'http',
    sid: 1,
    runtimeId: 'runtime-1',
    method: 'POST',
    path: '/api/conversations/1/events',
    traceparent: `00-${traceId}-${'b'.repeat(16)}-01`,
  })
  await nextFrameOf(sent, 'http_res')
  spyriaAgent.stop(true)
  expect(received[0]).toMatch(new RegExp(`^00-${traceId}-(?!${'b'.repeat(16)})[0-9a-f]{16}-01$`))
})
