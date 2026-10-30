import { runCommand } from './checkout.ts'

export type CheckResult = { name: string; command: string; exitCode?: number; output: string }
export type ChecksRun = { state: 'idle' | 'running' | 'finished'; results: CheckResult[] }
type Check = { name: string; command: string; timeoutMilliseconds: number }

const shownOutputLines = 80
const shownOutputCharacters = 8_000
const maximumChecks = 20
const maximumTimeoutMinutes = 120

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

export const checksOf = (body: unknown): Check[] | { failure: string } => {
  const checks = (body as { checks?: unknown } | undefined)?.checks
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > maximumChecks)
    return { failure: `Give between 1 and ${maximumChecks} checks` }
  const parsed = checks.map((check) => {
    const { name, command, timeout_minutes: minutes } = (check ?? {}) as Record<string, unknown>
    const isTimeout = Number.isSafeInteger(minutes) && Number(minutes) > 0 && Number(minutes) <= maximumTimeoutMinutes
    return isText(name) && isText(command) && isTimeout
      ? { name, command, timeoutMilliseconds: Number(minutes) * 60_000 }
      : undefined
  })
  return parsed.every((check) => check !== undefined)
    ? parsed
    : { failure: 'Each check needs a name, a command and a timeout in minutes' }
}

const shownOutputOf = (output: string) =>
  output.trimEnd().split('\n').slice(-shownOutputLines).join('\n').slice(-shownOutputCharacters)

export const createChecksRunner = ({
  cwd,
  environment,
}: {
  cwd: string
  environment: () => Record<string, string>
}) => {
  let run: ChecksRun = { state: 'idle', results: [] }
  const resultOf = async ({ name, command, timeoutMilliseconds }: Check): Promise<CheckResult> => {
    try {
      const { exitCode, output } = await runCommand(command, cwd, environment(), timeoutMilliseconds, () => undefined)
      return { name, command, ...(exitCode !== undefined && { exitCode }), output: shownOutputOf(output) }
    } catch (error) {
      return { name, command, output: `The check could not start: ${error instanceof Error ? error.message : error}` }
    }
  }
  const runAll = async (current: ChecksRun, checks: Check[]) => {
    for (const check of checks) current.results.push(await resultOf(check))
    current.state = 'finished'
  }
  return {
    start: (body: unknown): ChecksRun | { failure: string } => {
      if (run.state === 'running') return run
      const checks = checksOf(body)
      if ('failure' in checks) return checks
      run = { state: 'running', results: [] }
      void runAll(run, checks)
      return run
    },
    status: () => run,
  }
}
