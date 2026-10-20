export type LogSeverity = 'INFO' | 'WARN' | 'ERROR'
export type LogAttributes = Record<string, string | number | boolean | undefined>
export type LogEvent = { event: string; body: string; attributes?: LogAttributes; error?: unknown }
export type LogOutput = (severity: LogSeverity, logEvent: LogEvent) => void

export const exceptionAttributesOf = (error: unknown): LogAttributes =>
  error instanceof Error
    ? {
        'error.type': error.name,
        'exception.type': error.name,
        'exception.message': error.message,
        'exception.stacktrace': error.stack,
      }
    : { 'error.type': 'unknown', 'exception.message': String(error) }

const stdoutOutput: LogOutput = (severity, { event, body, attributes, error }) =>
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      severity,
      body,
      'event.name': event,
      ...attributes,
      ...(error !== undefined && exceptionAttributesOf(error)),
    }),
  )
let output = stdoutOutput

export const setLogOutput = (next: LogOutput | undefined) => {
  output = next ?? stdoutOutput
}

export const log = {
  info: (logEvent: LogEvent) => output('INFO', logEvent),
  warn: (logEvent: LogEvent) => output('WARN', logEvent),
  error: (logEvent: LogEvent) => output('ERROR', logEvent),
}
