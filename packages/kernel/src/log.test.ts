import { afterEach, expect, spyOn, test } from 'bun:test'
import { log, setLogOutput } from './log.ts'

afterEach(() => setLogOutput(undefined))

test('without a plugged output, a log event is one JSON line on stdout with its exception as strings', () => {
  const printed = spyOn(console, 'log').mockImplementation(() => {})
  log.error({ event: 'job.run', body: 'Job failed', attributes: { 'job.id': 'job-1' }, error: new Error('Boom') })
  const [line] = printed.mock.calls.map(([text]) => JSON.parse(String(text)))
  printed.mockRestore()
  expect(line).toEqual({
    timestamp: expect.any(String),
    severity: 'ERROR',
    body: 'Job failed',
    'event.name': 'job.run',
    'job.id': 'job-1',
    'error.type': 'Error',
    'exception.type': 'Error',
    'exception.message': 'Boom',
    'exception.stacktrace': expect.stringContaining('Error: Boom'),
  })
})

test('a plugged output receives every event with its severity', () => {
  const received: unknown[] = []
  setLogOutput((severity, logEvent) => received.push([severity, logEvent.event]))
  log.info({ event: 'http.request', body: 'Request handled' })
  log.warn({ event: 'job.run', body: 'Job failed and will be retried' })
  expect(received).toEqual([
    ['INFO', 'http.request'],
    ['WARN', 'job.run'],
  ])
})

test('a failed query is logged by its class and code only, without its parameters', () => {
  const printed = spyOn(console, 'log').mockImplementation(() => {})
  const failedQuery = Object.assign(
    new Error('Failed query: update runtimes set llm_token_hash = $1\nparams: s3cret'),
    {
      name: 'DrizzleQueryError',
      params: ['s3cret'],
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    },
  )
  log.error({ event: 'job.run', body: 'Job failed', error: failedQuery })
  const [line] = printed.mock.calls.map(([text]) => String(text))
  printed.mockRestore()
  expect(line).not.toContain('s3cret')
  expect(JSON.parse(line ?? '')).toMatchObject({
    'exception.type': 'DrizzleQueryError',
    'exception.message': 'DrizzleQueryError 40P01',
    'exception.stacktrace': expect.stringContaining('at '),
  })
})
