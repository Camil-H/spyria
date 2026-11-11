import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { outputTailOf } from './output-tail.ts'
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
export type Preparation = { url: string; token: string; setup_command?: string }
export type Checkout = { failure?: string; setupCommand?: string }
export type Prepared = { failure?: string; branch?: string; head?: string; isRestored?: boolean }
export type CheckoutDirectories = { snapshot: string; home: string }
type Environment = Record<string, string>

const withSetup = (repository: Pick<Repository, 'setup_command'>): Checkout => {
  const setupCommand = repository.setup_command?.trim()
  return setupCommand ? { setupCommand } : {}
}
const shownOutputLines = 20
const keptOutputCharacters = 20_000
const shownOutputIntervalMilliseconds = 250
const outputDrainMilliseconds = 1_000

export const lastLinesOf = (output: string) => output.trimEnd().split('\n').slice(-shownOutputLines).join('\n')

const run = async (command: string[], cwd: string, env: Environment) => {
  const child = Bun.spawn(command, { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { exitCode: await child.exited, output: `${stdout}${stderr}`, stdout: stdout.trim() }
}

const cloneEnvironmentOf = (environment: Environment, token: string) => ({
  ...environment,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
})

const remoteBranchOf = (branch: string) => `refs/remotes/origin/${branch}`
const hasClone = (cwd: string) => existsSync(join(cwd, '.git'))

const isRef = async (cwd: string, ref: string, environment: Environment) =>
  (await run(['git', 'rev-parse', '--verify', '--quiet', ref], cwd, environment)).exitCode === 0

const currentBranchOf = async (cwd: string, environment: Environment) =>
  (await run(['git', 'symbolic-ref', '--short', 'HEAD'], cwd, environment)).stdout

export const headOf = async (cwd: string, environment: Environment) =>
  (await run(['git', 'rev-parse', 'HEAD'], cwd, environment)).stdout

const fetchBranch = (cwd: string, branch: string, token: string, environment: Environment) =>
  run(
    ['git', 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:${remoteBranchOf(branch)}`],
    cwd,
    cloneEnvironmentOf(environment, token),
  )

const clone = async (cwd: string, url: string, token: string, environment: Environment, branch?: string) => {
  mkdirSync(cwd, { recursive: true })
  const cloned = await run(
    ['git', 'clone', '--quiet', ...(branch ? ['--branch', branch] : []), url, '.'],
    cwd,
    cloneEnvironmentOf(environment, token),
  )
  return cloned.exitCode === 0 ? undefined : `The repository could not be cloned: ${lastLinesOf(cloned.output)}`
}

const restored = async (cwd: string, { snapshot, home }: CheckoutDirectories, environment: Environment) => {
  if (!existsSync(join(snapshot, 'complete'))) return false
  mkdirSync(cwd, { recursive: true })
  const project = await run(['cp', '-a', `${join(snapshot, 'project')}/.`, cwd], cwd, environment)
  const homeFiles = await run(['cp', '-a', `${join(snapshot, 'home')}/.`, home], cwd, environment)
  if (project.exitCode === 0 && homeFiles.exitCode === 0 && hasClone(cwd)) return true
  rmSync(cwd, { recursive: true, force: true })
  return false
}

const startPointOf = async (cwd: string, repository: Repository, environment: Environment) => {
  const startPoint = repository.start_branch && remoteBranchOf(repository.start_branch)
  return startPoint && (await isRef(cwd, startPoint, environment)) ? startPoint : remoteBranchOf(repository.base_branch)
}

const branched = async (cwd: string, repository: Repository, environment: Environment): Promise<Checkout> => {
  const startPoint = await startPointOf(cwd, repository, environment)
  const checkout = (options: string[]) =>
    run(
      ['git', 'checkout', '--quiet', ...options, '--no-track', '-b', repository.working_branch, startPoint],
      cwd,
      environment,
    )
  const carried = await checkout([])
  const branch = carried.exitCode === 0 ? carried : await checkout(['--force'])
  if (branch.exitCode !== 0)
    return { failure: `The working branch could not be created: ${lastLinesOf(branch.output)}` }
  return withSetup(repository)
}

const fetchedAndBranched = async (cwd: string, repository: Repository, environment: Environment) => {
  const base = await fetchBranch(cwd, repository.base_branch, repository.token, environment)
  if (base.exitCode !== 0) return { failure: `The base branch could not be fetched: ${lastLinesOf(base.output)}` }
  if (repository.start_branch) await fetchBranch(cwd, repository.start_branch, repository.token, environment)
  return branched(cwd, repository, environment)
}

const checkoutOf = async (
  cwd: string,
  repository: Repository,
  environment: Environment,
  directories: CheckoutDirectories,
): Promise<Checkout> => {
  if (hasClone(cwd) && (await isRef(cwd, `refs/heads/${repository.working_branch}`, environment)))
    return withSetup(repository)
  if (hasClone(cwd) || (await restored(cwd, directories, environment)))
    return fetchedAndBranched(cwd, repository, environment)
  const failure = await clone(cwd, repository.url, repository.token, environment, repository.base_branch)
  return failure ? { failure } : branched(cwd, repository, environment)
}

const identified = async (cwd: string, author: unknown, environment: Environment) => {
  const identity = gitIdentityOf(author)
  if (!identity) return true
  const named = await run(['git', 'config', '--local', 'user.name', identity.name], cwd, environment)
  const emailed = await run(['git', 'config', '--local', 'user.email', identity.email], cwd, environment)
  return named.exitCode === 0 && emailed.exitCode === 0
}

export const checkOut = async (
  cwd: string,
  repository: Repository,
  environment: Environment,
  directories: CheckoutDirectories,
): Promise<Checkout> => {
  const checkout = await checkoutOf(cwd, repository, environment, directories)
  if (checkout.failure || (await identified(cwd, repository.author, environment))) return checkout
  return { failure: 'The commit author could not be set in the repository' }
}

const refreshed = async (cwd: string, token: string, environment: Environment) => {
  const branch = await currentBranchOf(cwd, environment)
  const fetched = await fetchBranch(cwd, branch, token, environment)
  if (fetched.exitCode !== 0) return `The default branch could not be fetched: ${lastLinesOf(fetched.output)}`
  const reset = await run(['git', 'reset', '--quiet', '--hard', remoteBranchOf(branch)], cwd, environment)
  return reset.exitCode === 0 ? undefined : `The default branch could not be checked out: ${lastLinesOf(reset.output)}`
}

export const prepare = async (
  cwd: string,
  preparation: Preparation,
  environment: Environment,
  directories: CheckoutDirectories,
): Promise<Prepared> => {
  const isRestored = !hasClone(cwd) && (await restored(cwd, directories, environment))
  const failure = isRestored
    ? await refreshed(cwd, preparation.token, environment)
    : await clone(cwd, preparation.url, preparation.token, environment)
  if (failure) return { failure }
  return { branch: await currentBranchOf(cwd, environment), head: await headOf(cwd, environment), isRestored }
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
      output = outputTailOf(output + decoder.decode(chunk, { stream: true }), keptOutputCharacters)
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
