import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './checkout.ts'

export type CheckResult = { name: string; command: string; exitCode?: number; output: string }
export type ChecksRun = { state: 'idle' | 'running' | 'finished'; results: CheckResult[]; ci?: string[] }
type DevLoopConfig = { checks: [name: string, command: string][]; ci?: string[] }

const devLoopConfigPath = '.spyria/dev-loop.json'
const shownOutputLines = 80
const shownOutputCharacters = 8_000

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')

const isCommandMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((command) => typeof command === 'string' && command.trim() !== '')

export const devLoopConfigOf = (cwd: string): DevLoopConfig | { failure: string } => {
  const path = join(cwd, devLoopConfigPath)
  if (!existsSync(path)) return { checks: [] }
  const invalid = (reason: string) => ({ failure: `${devLoopConfigPath} is not valid: ${reason}` })
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return invalid('it is not JSON')
  }
  const { checks = {}, ci } = (parsed ?? {}) as { checks?: unknown; ci?: unknown }
  if (!isCommandMap(checks)) return invalid('"checks" must map each check name to a command')
  if (ci !== undefined && !isStringList(ci)) return invalid('"ci" must list the names of the CI checks that count')
  return { checks: Object.entries(checks), ...(ci !== undefined && { ci }) }
}

const shownOutputOf = (output: string) =>
  output.trimEnd().split('\n').slice(-shownOutputLines).join('\n').slice(-shownOutputCharacters)

export const createChecksRunner = ({
  cwd,
  environment,
  timeoutMilliseconds,
}: {
  cwd: string
  environment: () => Record<string, string>
  timeoutMilliseconds: number
}) => {
  let run: ChecksRun = { state: 'idle', results: [] }
  const runAll = async (current: ChecksRun, checks: DevLoopConfig['checks']) => {
    for (const [name, command] of checks) {
      const { exitCode, output } = await runCommand(command, cwd, environment(), timeoutMilliseconds, () => undefined)
      current.results.push({
        name,
        command,
        ...(exitCode !== undefined && { exitCode }),
        output: shownOutputOf(output),
      })
    }
    current.state = 'finished'
  }
  return {
    start: (): ChecksRun | { failure: string } => {
      if (run.state === 'running') return run
      const config = devLoopConfigOf(cwd)
      if ('failure' in config) return config
      run = { state: 'running', results: [], ...(config.ci && { ci: config.ci }) }
      void runAll(run, config.checks)
      return run
    },
    status: () => run,
  }
}
