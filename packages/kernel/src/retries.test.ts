import { expect, test } from 'bun:test'
import { isConnectionRefused, withRetries } from './retries.ts'

const answering = (...statuses: (number | Error)[]) => {
  const signals: AbortSignal[] = []
  const attempt = async (signal: AbortSignal) => {
    signals.push(signal)
    const next = statuses[Math.min(signals.length, statuses.length) - 1] ?? 200
    if (next instanceof Error) throw next
    return new Response(null, { status: next })
  }
  return { attempt, attempts: () => signals.length }
}
const refused = () => Object.assign(new Error('Unable to connect'), { code: 'ConnectionRefused' })
const fast = { timeoutMilliseconds: 2_000, firstDelayMilliseconds: 1 }

test('network errors, 429, 502, 503 and 504 are retried until an answer, at most 3 attempts', async () => {
  for (const failure of [429, 502, 503, 504, refused()]) {
    const gateway = answering(failure, 200)
    expect((await withRetries(gateway.attempt, fast)).status).toBe(200)
    expect(gateway.attempts()).toBe(2)
  }
  const alwaysDown = answering(503)
  expect((await withRetries(alwaysDown.attempt, fast)).status).toBe(503)
  expect(alwaysDown.attempts()).toBe(3)
  const alwaysRefused = answering(refused())
  await expect(withRetries(alwaysRefused.attempt, fast)).rejects.toMatchObject({ code: 'ConnectionRefused' })
  expect(alwaysRefused.attempts()).toBe(3)
})

test('4xx answers, 500, timeouts and other errors are not retried', async () => {
  for (const failure of [400, 401, 404, 409, 500]) {
    const gateway = answering(failure, 200)
    expect((await withRetries(gateway.attempt, fast)).status).toBe(failure)
    expect(gateway.attempts()).toBe(1)
  }
  for (const failure of [new DOMException('timed out', 'TimeoutError'), new SyntaxError('bad JSON')]) {
    const gateway = answering(failure as Error, 200)
    await expect(withRetries(gateway.attempt, fast)).rejects.toBe(failure)
    expect(gateway.attempts()).toBe(1)
  }
})

test('Retry-After is honoured, and a wait past the caller’s timeout returns the last answer at once', async () => {
  let calls = 0
  const busyOnce = async () =>
    ++calls === 1 ? new Response(null, { status: 503, headers: { 'retry-after': '1' } }) : new Response('ok')
  const startedAt = Date.now()
  expect(await (await withRetries(busyOnce, { timeoutMilliseconds: 5_000 })).text()).toBe('ok')
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950)
  const busyLong = async () => new Response(null, { status: 429, headers: { 'retry-after': '30' } })
  const boundedAt = Date.now()
  expect((await withRetries(busyLong, { timeoutMilliseconds: 500 })).status).toBe(429)
  expect(Date.now() - boundedAt).toBeLessThan(100)
})

test('every attempt shares one signal that aborts at the caller’s timeout', async () => {
  const hanging = (signal: AbortSignal) =>
    new Promise<Response>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const startedAt = Date.now()
  await expect(withRetries(hanging, { timeoutMilliseconds: 100 })).rejects.toMatchObject({ name: 'TimeoutError' })
  expect(Date.now() - startedAt).toBeLessThan(1_000)
})

test('a custom rule retries thrown errors it names, and a refused connection is recognised', async () => {
  let calls = 0
  const sendOnce = async () => {
    if (++calls === 1) throw refused()
    return 'sent'
  }
  expect(
    await withRetries(sendOnce, {
      ...fast,
      isRetried: (outcome) => 'error' in outcome && isConnectionRefused(outcome.error),
    }),
  ).toBe('sent')
  expect(calls).toBe(2)
  expect(isConnectionRefused(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true)
  expect(isConnectionRefused(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false)
})
