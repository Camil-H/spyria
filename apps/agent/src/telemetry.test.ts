import { afterEach, expect, test } from 'bun:test'
import { contextOf, log, startTelemetry, withSpan } from './telemetry.ts'

let lines: Record<string, unknown>[] = []
let telemetry: ReturnType<typeof startTelemetry> | undefined
afterEach(() => telemetry?.shutdown())

test('an agent line continues the trace of the traceparent it was given, as spyria-agent', async () => {
  telemetry = startTelemetry({ write: (line) => void lines.push(JSON.parse(line)) })
  lines = []
  const traceId = 'c'.repeat(32)
  await withSpan(
    'agent.turn',
    {},
    async () => log.info({ event: 'agent.turn', body: 'Agent turn ended', attributes: { 'conversation.id': 'c-1' } }),
    contextOf({ traceparent: `00-${traceId}-${'d'.repeat(16)}-01` }),
  )
  expect(lines[0]).toMatchObject({
    'event.name': 'agent.turn',
    'service.name': 'spyria-agent',
    trace_id: traceId,
    'conversation.id': 'c-1',
  })
})
