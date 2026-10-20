export type RetryOutcome<Result> = { result: Result } | { error: unknown }
type RetrySettings<Result> = {
  timeoutMilliseconds: number
  attempts?: number
  firstDelayMilliseconds?: number
  isRetried?: (outcome: RetryOutcome<Result>) => boolean
}

const retriedStatuses = new Set([429, 502, 503, 504])

export const isConnectionRefused = (error: unknown) =>
  ['ConnectionRefused', 'ECONNREFUSED'].includes(String((error as { code?: unknown })?.code))

export const isNetworkError = (error: unknown) =>
  error instanceof Error &&
  error.name !== 'TimeoutError' &&
  error.name !== 'AbortError' &&
  (typeof (error as { code?: unknown }).code === 'string' || error instanceof TypeError)

export const isRetriedResponse = (outcome: RetryOutcome<unknown>) =>
  'error' in outcome
    ? isNetworkError(outcome.error)
    : outcome.result instanceof Response && retriedStatuses.has(outcome.result.status)

const retryAfterMillisecondsOf = (outcome: RetryOutcome<unknown>) => {
  const header = 'result' in outcome && outcome.result instanceof Response && outcome.result.headers.get('retry-after')
  if (!header) return undefined
  const milliseconds = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return Number.isNaN(milliseconds) ? undefined : Math.max(0, milliseconds)
}

export const withRetries = async <Result>(
  attempt: (signal: AbortSignal) => Promise<Result>,
  {
    timeoutMilliseconds,
    attempts = 3,
    firstDelayMilliseconds = 250,
    isRetried = isRetriedResponse,
  }: RetrySettings<Result>,
): Promise<Result> => {
  const signal = AbortSignal.timeout(timeoutMilliseconds)
  const deadline = Date.now() + timeoutMilliseconds
  for (let attemptNumber = 1; ; attemptNumber++) {
    const outcome: RetryOutcome<Result> = await attempt(signal).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    )
    const delay =
      retryAfterMillisecondsOf(outcome) ?? firstDelayMilliseconds * 2 ** (attemptNumber - 1) * (0.5 + Math.random() / 2)
    if (attemptNumber >= attempts || signal.aborted || !isRetried(outcome) || Date.now() + delay >= deadline) {
      if ('error' in outcome) throw outcome.error
      return outcome.result
    }
    if ('result' in outcome && outcome.result instanceof Response) await outcome.result.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
}
