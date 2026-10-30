import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gitIdentityOf } from './workspace.ts'

export type Repository = {
  url: string
  token: string
  base_branch: string
  working_branch: string
  start_branch?: string
  author?: unknown
  setup_command?: string
}
export type Checkout = { failure?: string; setupCommand?: string }

const setupScript = '.spyria/setup.sh'

const setupCommandOf = (cwd: string, repository: Repository) =>
  repository.setup_command?.trim() || (existsSync(join(cwd, setupScript)) ? `sh ${setupScript}` : undefined)
const withSetup = (cwd: string, repository: Repository): Checkout => {
  const setupCommand = setupCommandOf(cwd, repository)
  return setupCommand ? { setupCommand } : {}
}
const shownOutputLines = 20
const keptOutputCharacters = 20_000
const shownOutputIntervalMilliseconds = 250
const outputDrainMilliseconds = 1_000

export const lastLinesOf = (output: string) => output.trimEnd().split('\n').slice(-shownOutputLines).join('\n')

const run = async (command: string[], cwd: string, env: Record<string, string>) => {
  const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode: await child.exited, output: `${stdout}${stderr}` }
}

const cloneEnvironmentOf = (environment: Record<string, string>, token: string) => ({
  ...environment,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
})

const cloned = async (cwd: string, repository: Repository, environment: Record<string, string>): Promise<Checkout> => {
  mkdirSync(cwd, { recursive: true })
  const clone = await run(
    ['git', 'clone', '--quiet', '--branch', repository.base_branch, repository.url, '.'],
    cwd,
    cloneEnvironmentOf(environment, repository.token),
  )
  if (clone.exitCode !== 0) return { failure: `The repository could not be cloned: ${lastLinesOf(clone.output)}` }
  const startPoint = repository.start_branch && `refs/remotes/origin/${repository.start_branch}`
  const hasStartPoint =
    startPoint && (await run(['git', 'rev-parse', '--verify', '--quiet', startPoint], cwd, environment)).exitCode === 0
  const branch = await run(
    [
      'git',
      'checkout',
      '--quiet',
      '--no-track',
      '-b',
      repository.working_branch,
      ...(hasStartPoint ? [startPoint] : []),
    ],
    cwd,
    environment,
  )
  if (branch.exitCode !== 0)
    return { failure: `The working branch could not be created: ${lastLinesOf(branch.output)}` }
  return withSetup(cwd, repository)
}

const identified = async (cwd: string, author: unknown, environment: Record<string, string>) => {
  const identity = gitIdentityOf(author)
  if (!identity) return true
  const named = await run(['git', 'config', '--local', 'user.name', identity.name], cwd, environment)
  const emailed = await run(['git', 'config', '--local', 'user.email', identity.email], cwd, environment)
  return named.exitCode === 0 && emailed.exitCode === 0
}

export const checkOut = async (
  cwd: string,
  repository: Repository,
  environment: Record<string, string>,
): Promise<Checkout> => {
  const checkout = existsSync(join(cwd, '.git'))
    ? withSetup(cwd, repository)
    : await cloned(cwd, repository, environment)
  if (checkout.failure || (await identified(cwd, repository.author, environment))) return checkout
  return { failure: 'The commit author could not be set in the repository' }
}

const killGroup = (leaderPid: number) => {
  try {
    process.kill(-leaderPid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

export const runCommand = async (
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMilliseconds: number,
  onOutput: (output: string) => void,
) => {
  const child = Bun.spawn(['sh', '-c', `exec 2>&1\n${command}`], {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    detached: true,
  })
  const decoder = new TextDecoder()
  let output = ''
  let isOver = false
  let shownAt = Number.NEGATIVE_INFINITY
  let pendingShow: ReturnType<typeof setTimeout> | undefined
  const show = () => {
    pendingShow = undefined
    shownAt = performance.now()
    onOutput(output)
  }
  const reading = (async () => {
    for await (const chunk of child.stdout) {
      if (isOver) continue
      output = (output + decoder.decode(chunk, { stream: true })).slice(-keptOutputCharacters)
      if (pendingShow) continue
      const wait = shownAt + shownOutputIntervalMilliseconds - performance.now()
      if (wait <= 0) show()
      else pendingShow = setTimeout(show, wait)
    }
  })()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const exitCode = await Promise.race([
    child.exited,
    new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => resolve(undefined), timeoutMilliseconds)
    }),
  ])
  clearTimeout(timeout)
  if (exitCode === undefined) killGroup(child.pid)
  await Promise.race([reading, Bun.sleep(outputDrainMilliseconds)])
  isOver = true
  clearTimeout(pendingShow)
  return { exitCode, output }
}
