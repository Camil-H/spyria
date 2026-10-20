import {
  type Attributes,
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { hrTimeToMilliseconds, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'

type Carrier = Record<string, unknown>
type LogAttributes = Record<string, string | number | boolean | undefined>
type LogEvent = { event: string; body: string; attributes?: LogAttributes; error?: unknown }

const severityNumbers = { INFO: SeverityNumber.INFO, WARN: SeverityNumber.WARN, ERROR: SeverityNumber.ERROR }
const secretKeyPart = /^(token|secret|password|authorization|cookie|key|body|prompt|content|query|full)$/i
const writeToStdout = (line: string) => void process.stdout.write(`${line}\n`)

export const loggedAttributesOf = (attributes: LogAttributes) =>
  Object.fromEntries(
    Object.entries(attributes).flatMap(([key, value]) =>
      value === undefined || key.split(/[._-]|(?=[A-Z])/).some((part) => secretKeyPart.test(part))
        ? []
        : [[key, key === 'url.path' ? String(value).split('?')[0] : value]],
    ),
  )

const exceptionAttributesOf = (error: unknown): LogAttributes =>
  error instanceof Error
    ? {
        'error.type': error.name,
        'exception.type': error.name,
        'exception.message': error.message,
        'exception.stacktrace': error.stack,
      }
    : { 'error.type': 'unknown', 'exception.message': String(error) }

const emitted =
  (severity: keyof typeof severityNumbers) =>
  ({ event, body, attributes = {}, error }: LogEvent) =>
    logs.getLogger('spyria').emit({
      severityNumber: severityNumbers[severity],
      severityText: severity,
      body,
      eventName: event,
      attributes: loggedAttributesOf({ ...attributes, ...(error !== undefined && exceptionAttributesOf(error)) }),
    })

export const log = { info: emitted('INFO'), warn: emitted('WARN'), error: emitted('ERROR') }

export const lineOf = (record: ReadableLogRecord) =>
  JSON.stringify({
    timestamp: new Date(hrTimeToMilliseconds(record.hrTime)).toISOString(),
    severity: record.severityText,
    body: record.body,
    'event.name': record.eventName,
    trace_id: record.spanContext?.traceId,
    span_id: record.spanContext?.spanId,
    'service.name': record.resource.attributes['service.name'],
    'deployment.environment.name': record.resource.attributes['deployment.environment.name'],
    ...record.attributes,
  })

export const startTelemetry = ({ serviceName = 'spyria-host', write = writeToStdout } = {}) => {
  const resource = resourceFromAttributes({
    'service.name': process.env.OTEL_SERVICE_NAME || serviceName,
    'deployment.environment.name': process.env.SPYRIA_ENV || 'development',
  })
  const isExported = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: isExported ? [new BatchSpanProcessor(new OTLPTraceExporter())] : [],
  })
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      { onEmit: (record) => write(lineOf(record)), forceFlush: async () => {}, shutdown: async () => {} },
      ...(isExported ? [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })] : []),
    ],
  })
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(tracerProvider)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  logs.setGlobalLoggerProvider(loggerProvider)
  return {
    shutdown: async () => {
      await Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown()])
      trace.disable()
      context.disable()
      propagation.disable()
      logs.disable()
    },
  }
}

export const withSpan = <Result>(
  name: string,
  attributes: Attributes,
  work: (span: Span) => Promise<Result>,
  parent: Context = context.active(),
) =>
  trace.getTracer('spyria').startActiveSpan(name, { attributes }, parent, async (span) => {
    try {
      return await work(span)
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw error
    } finally {
      span.end()
    }
  })

export const traceHeadersOf = (activeContext: Context = context.active()) => {
  const carrier: Record<string, string> = {}
  propagation.inject(activeContext, carrier)
  return carrier
}

export const contextOf = ({ traceparent, tracestate }: Carrier) =>
  typeof traceparent === 'string'
    ? propagation.extract(ROOT_CONTEXT, { traceparent, ...(typeof tracestate === 'string' && { tracestate }) })
    : ROOT_CONTEXT
