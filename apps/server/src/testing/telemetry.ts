import { startTelemetry } from '../telemetry.ts'

export const startCollector = () => {
  const received: { path: string; text: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push({ path: new URL(request.url).pathname, text: await request.text() })
      return Response.json({})
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    paths: () => received.map(({ path }) => path),
    text: () => received.map(({ text }) => text).join('\n'),
    stop: () => server.stop(true),
  }
}

export const startTestTelemetry = ({ otlpEndpoint }: { otlpEndpoint?: string }) => {
  const written: string[] = []
  if (otlpEndpoint) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = otlpEndpoint
  else delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  const telemetry = startTelemetry({ write: (line) => void written.push(line) })
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  let stopping: Promise<void> | undefined
  return {
    lines: () =>
      written.map((line) => {
        const parsed = JSON.parse(line)
        return { ...parsed, event: parsed['event.name'] }
      }),
    text: () => written.join('\n'),
    stop: () => {
      stopping ??= telemetry.shutdown()
      return stopping
    },
  }
}
