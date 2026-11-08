import { join } from 'node:path'

const ownSettingPattern = /^(SPYRIA_|COMPOSE_|OTEL_|CLOUDFLARE_)/

export const environmentFileOf = (folder: string) => join(folder, '.env')
export const composeFileOf = (folder: string) => join(folder, 'compose.yml')

export const composeCommandOf = (folder: string, composeArguments: string[]) => [
  'docker',
  'compose',
  '--env-file',
  environmentFileOf(folder),
  '-f',
  composeFileOf(folder),
  ...composeArguments,
]

export const shellEnvironmentOf = (environment: Record<string, string | undefined>) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !ownSettingPattern.test(entry[0]),
    ),
  )

export const runCompose = (folder: string, composeArguments: string[], input?: string) =>
  Bun.spawnSync(composeCommandOf(folder, composeArguments), {
    cwd: folder,
    env: shellEnvironmentOf(process.env),
    stdin: input === undefined ? 'inherit' : new TextEncoder().encode(input),
    stdout: 'inherit',
    stderr: 'inherit',
  }).exitCode

export const readCompose = (folder: string, composeArguments: string[]) => {
  const result = Bun.spawnSync(composeCommandOf(folder, composeArguments), {
    cwd: folder,
    env: shellEnvironmentOf(process.env),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { exitCode: result.exitCode, output: result.stdout.toString(), errors: result.stderr.toString() }
}

export const spawnCompose = (
  folder: string,
  composeArguments: string[],
  streams: { stdin?: ReturnType<typeof Bun.file>; stdout?: ReturnType<typeof Bun.file> },
) =>
  Bun.spawn(composeCommandOf(folder, composeArguments), {
    cwd: folder,
    env: shellEnvironmentOf(process.env),
    stdin: streams.stdin ?? 'ignore',
    stdout: streams.stdout ?? 'inherit',
    stderr: 'inherit',
  }).exited

export const operatorCommandOf = (operatorArguments: string[]) => [
  'exec',
  '-T',
  'server',
  'bun',
  'apps/server/src/operator-cli.ts',
  ...operatorArguments,
]
