import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { log } from '@spyria/kernel'
import { withSpan } from './telemetry.ts'
import { startCollector, startTestTelemetry } from './testing/telemetry.ts'
import { startAgentStack, waitFor } from './testing/testing.ts'

setDefaultTimeout(40_000)
const collector = startCollector()
const telemetry = startTestTelemetry({ otlpEndpoint: collector.url })
const gatewayHeaders: Record<string, string>[] = []
let gatewayUrl = ''
const gatewayProxy = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch: (request) => {
    gatewayHeaders.push(Object.fromEntries(request.headers))
    const { pathname, search } = new URL(request.url)
    return fetch(`${gatewayUrl}${pathname}${search}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
    })
  },
})
const { database, llmGateway, prompt, ...stack } = await startAgentStack({
  routing: true,
  gatewayUrlOf: () => `http://127.0.0.1:${gatewayProxy.port}`,
})
gatewayUrl = llmGateway.url
afterAll(async () => {
  await telemetry.stop()
  collector.stop()
  void gatewayProxy.stop(true)
})

test('one turn: the request, its job, the agent turn and the model call share one trace, carried in the job payload and forwarded to the gateway, and exported over OTLP', async () => {
  const { relay } = await stack.agentHost('Traced host', { routesModelCalls: true })
  const chat = await stack.newRuntimeChat()
  const promptId = await prompt(chat, 'Trace this turn')
  await waitFor(
    () => telemetry.lines().some((line) => line.event === 'agent.turn' && line['turn.id'] === promptId),
    20_000,
  )
  const [job] = await database.$client<{ payload: { traceparent?: string } }[]>`
    select payload from jobs where type = 'agent.prompt' and payload->>'messageId' = ${promptId}`
  const traceId = job?.payload.traceparent?.split('-')[1]
  expect(job?.payload.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
  const traced = telemetry.lines().filter((line) => line.trace_id === traceId)
  expect(traced.find((line) => line.event === 'http.request')).toMatchObject({
    'event.name': 'http.request',
    'service.name': 'spyria-server',
    'http.request.method': 'POST',
    'url.path': '/api/mutate',
    'http.response.status_code': 200,
  })
  expect(
    traced.filter((line) => line.event === 'job.run').map((line) => [line['job.type'], line['job.outcome']]),
  ).toContainEqual(['agent.prompt', 'done'])
  expect(traced.find((line) => line.event === 'gen_ai.call')).toMatchObject({
    'gen_ai.operation.name': 'chat',
    'gen_ai.request.model': expect.any(String),
    'chat.id': chat,
    'turn.id': promptId,
    'http.response.status_code': 200,
    'gen_ai.usage.input_tokens': expect.any(Number),
    'gen_ai.usage.output_tokens': expect.any(Number),
  })
  expect(traced.find((line) => line.event === 'agent.turn')).toMatchObject({ 'chat.id': chat, 'turn.id': promptId })
  const agentLines = relay.agentLogLines().map((line) => JSON.parse(line))
  expect(agentLines.find((line) => line['event.name'] === 'agent.turn')).toMatchObject({
    'service.name': 'spyria-agent',
    trace_id: traceId,
  })
  expect(gatewayHeaders.map((headers) => headers.traceparent?.split('-')[1])).toContain(traceId)
  expect(telemetry.text()).not.toContain('appID=')
  expect(telemetry.text()).not.toMatch(/authorization|Bearer|sk-|session-api-key/i)
  await telemetry.stop()
  expect(collector.paths()).toEqual(expect.arrayContaining(['/v1/traces', '/v1/logs']))
  expect(collector.text()).toContain(String(traceId))
})

test('without OTEL_EXPORTER_OTLP_ENDPOINT nothing is exported, and stdout lines are still written', async () => {
  const quiet = startTestTelemetry({})
  const exportedBefore = collector.paths().length
  await withSpan('quiet', {}, async () => log.info({ event: 'test.quiet', body: 'Quiet event' }))
  await quiet.stop()
  expect(quiet.lines().map((line) => line.event)).toEqual(['test.quiet'])
  expect(collector.paths()).toHaveLength(exportedBefore)
})
