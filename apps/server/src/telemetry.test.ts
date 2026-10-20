import { afterEach, expect, test } from 'bun:test'
import { log } from '@spyria/kernel'
import { createUsageReader } from './llm-relay.ts'
import { contextOf, startTelemetry, traceHeadersOf, withSpan } from './telemetry.ts'

let lines: Record<string, unknown>[] = []
let telemetry: ReturnType<typeof startTelemetry> | undefined
const started = () => {
  lines = []
  telemetry = startTelemetry({ write: (line) => void lines.push(JSON.parse(line)) })
}
afterEach(() => telemetry?.shutdown())

test('a log line carries the record fields, the active span ids, the service and the domain ids', async () => {
  started()
  const ids = await withSpan('chat.turn', {}, async (span) => {
    log.info({ event: 'agent.turn', body: 'Agent turn ended', attributes: { 'chat.id': 'chat-1', duration_ms: 12 } })
    return span.spanContext()
  })
  expect(lines).toEqual([
    {
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      severity: 'INFO',
      body: 'Agent turn ended',
      'event.name': 'agent.turn',
      trace_id: ids.traceId,
      span_id: ids.spanId,
      'service.name': 'spyria-server',
      'deployment.environment.name': 'development',
      'chat.id': 'chat-1',
      duration_ms: 12,
    },
  ])
})

test('an error is logged as single-string exception attributes', () => {
  started()
  log.error({ event: 'job.run', body: 'Job failed after its last attempt', error: new TypeError('No such message') })
  expect(lines[0]).toMatchObject({
    severity: 'ERROR',
    'error.type': 'TypeError',
    'exception.type': 'TypeError',
    'exception.message': 'No such message',
    'exception.stacktrace': expect.stringContaining('TypeError: No such message\n    at '),
  })
})

test('a line never carries a query string or a secret-looking attribute', () => {
  started()
  log.info({
    event: 'http.request',
    body: 'Request handled',
    attributes: {
      'url.path': '/api/mutate?schema=s&appID=a',
      authorization: 'Bearer sk-secret',
      'http.request.header.cookie': 'spyria_s=1',
      'x-api-key': 'sk-key',
      'session.token': 'token-1',
      'gen_ai.prompt': 'my private prompt',
      'http.request.body': '{"text":"hi"}',
      'url.query': 'appID=a',
      'url.full': 'http://spyria.test/api/mutate?appID=a',
      'gen_ai.usage.input_tokens': 3,
    },
  })
  const { timestamp, trace_id, span_id, ...attributes } = lines[0] ?? {}
  expect(attributes).toEqual({
    severity: 'INFO',
    body: 'Request handled',
    'event.name': 'http.request',
    'service.name': 'spyria-server',
    'deployment.environment.name': 'development',
    'url.path': '/api/mutate',
    'gen_ai.usage.input_tokens': 3,
  })
})

test('trace headers injected in a span continue its trace, and no traceparent starts a new one', async () => {
  started()
  const { parent, headers } = await withSpan('job agent.prompt', {}, async (span) => ({
    parent: span.spanContext(),
    headers: traceHeadersOf(),
  }))
  expect(headers).toEqual({ traceparent: `00-${parent.traceId}-${parent.spanId}-01` })
  const childOf = (carrier: Record<string, unknown>) =>
    withSpan('host command create', {}, async (span) => span.spanContext(), contextOf(carrier))
  expect((await childOf(headers)).traceId).toBe(parent.traceId)
  expect((await childOf({})).traceId).not.toBe(parent.traceId)
  expect((await childOf({ traceparent: 42 })).traceId).not.toBe(parent.traceId)
})

test('the usage reader takes the token counts of OpenAI, Responses and Anthropic streams, even split across chunks', () => {
  const usageOf = (chunks: string[]) => {
    const reader = createUsageReader()
    for (const chunk of chunks) reader.read(chunk)
    return reader.usage
  }
  expect(
    usageOf(['data: {"choices":[]}\n\n', 'data: {"usage":{"prompt_tokens":12,"comp', 'letion_tokens":5}}\n\n']),
  ).toEqual({ 'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 5 })
  expect(
    usageOf([
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":30,"input_tokens_details":{"cached_tokens":4},"output_tokens":9}}}\n\n',
    ]),
  ).toEqual({ 'gen_ai.usage.input_tokens': 30, 'gen_ai.usage.output_tokens': 9 })
  expect(
    usageOf([
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":20,"cache_read_input_tokens":100,"output_tokens":1}}}\n\n',
      `event: content_block_delta\ndata: {"delta":{"text":"${'x'.repeat(5000)}"}}\n\n`,
      'event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n',
    ]),
  ).toEqual({ 'gen_ai.usage.input_tokens': 20, 'gen_ai.usage.output_tokens': 7 })
})
