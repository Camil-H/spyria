import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Repository = { url: string; token: string; base_branch: string; working_branch: string }
export type Checkout = { failure?: string; hasSetup?: boolean }

const setupScript = '.spyria/setup.sh'
export const setupCommand = `sh ${setupScript}`
const shownOutputLines = 20
const keptOutputCharacters = 20_000
const shownOutputIntervalMilliseconds = 250

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

export const checkOut = async (
  cwd: string,
  repository: Repository,
  environment: Record<string, string>,
): Promise<Checkout> => {
  if (existsSync(join(cwd, '.git'))) return {}
  mkdirSync(cwd, { recursive: true })
  const clone = await run(
    ['git', 'clone', '--quiet', '--branch', repository.base_branch, repository.url, '.'],
    cwd,
    cloneEnvironmentOf(environment, repository.token),
  )
  if (clone.exitCode !== 0) return { failure: `The repository could not be cloned: ${lastLinesOf(clone.output)}` }
  const branch = await run(['git', 'checkout', '--quiet', '-b', repository.working_branch], cwd, environment)
  if (branch.exitCode !== 0)
    return { failure: `The working branch could not be created: ${lastLinesOf(branch.output)}` }
  return { hasSetup: existsSync(join(cwd, setupScript)) }
}

export const runSetup = async (cwd: string, env: Record<string, string>, onOutput: (output: string) => void) => {
  const child = Bun.spawn(['sh', '-c', `${setupCommand} 2>&1`], { cwd, env, stdin: 'ignore', stdout: 'pipe' })
  const decoder = new TextDecoder()
  let output = ''
  let shownAt = Number.NEGATIVE_INFINITY
  let pendingShow: ReturnType<typeof setTimeout> | undefined
  const show = () => {
    pendingShow = undefined
    shownAt = performance.now()
    onOutput(output)
  }
  for await (const chunk of child.stdout) {
    output = (output + decoder.decode(chunk, { stream: true })).slice(-keptOutputCharacters)
    if (pendingShow) continue
    const wait = shownAt + shownOutputIntervalMilliseconds - performance.now()
    if (wait <= 0) show()
    else pendingShow = setTimeout(show, wait)
  }
  clearTimeout(pendingShow)
  return { exitCode: await child.exited, output }
}
