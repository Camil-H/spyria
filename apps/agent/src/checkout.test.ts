import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentTestbed, kindOf } from './testing.ts'

const { stubCommand, launchOf, started } = createAgentTestbed()
const directory = mkdtempSync(join(tmpdir(), 'hq-agent-checkout-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const token = 'ghs_installation_token_never_kept'

const git = (cwd: string, ...command: string[]) => {
  const result = Bun.spawnSync(['git', '-c', 'init.defaultBranch=main', ...command], { cwd, stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

const bareRepository = (name: string, files: Record<string, string>) => {
  const source = join(directory, `${name}-source`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(source, path, '..'), { recursive: true })
    writeFileSync(join(source, path), content)
  }
  git(source, 'init', '-q')
  git(source, 'add', '.')
  git(source, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first')
  git(directory, 'clone', '-q', '--bare', source, `${name}.git`)
  return `file://${join(directory, `${name}.git`)}`
}

const launchIn = (name: string, url: string, extra: object = {}) => {
  const workingDirectory = join(directory, `${name}-workspace`)
  const environmentFile = join(directory, `${name}-environment`)
  const repository = { url, token, base_branch: 'main', working_branch: 'hq/fix-totals-1a2b3c' }
  const command = ['sh', '-c', `env > ${environmentFile}; exec "$@"`, 'sh', ...stubCommand]
  return {
    launch: {
      ...launchOf({ acp_command: command }),
      workspace: { working_dir: workingDirectory },
      repository,
      ...extra,
    },
    workingDirectory,
    environmentFile,
  }
}

test('a launch with a repository clones it, checks out the working branch and runs the setup script before the agent starts; the token stays out of the agent and the repository config', async () => {
  const url = bareRepository('app', {
    'AGENTS.md': 'Rules',
    'src/AGENTS.md': 'Nested rules',
    '.hq/setup.sh': 'echo prepared > prepared.txt',
  })
  const { call, open, create } = started()
  const { launch, workingDirectory, environmentFile } = launchIn('app', url)
  const id = await create(launch)
  const socket = open(id)
  await socket.until(kindOf('workspace'))
  expect(socket.events.find(kindOf('workspace'))?.update).toEqual({
    sessionUpdate: 'workspace',
    cwd: workingDirectory,
    branch: 'hq/fix-totals-1a2b3c',
  })
  expect(socket.events.some(kindOf('setup_failed'))).toBe(false)
  for (const file of ['AGENTS.md', 'src/AGENTS.md', 'prepared.txt'])
    expect(existsSync(join(workingDirectory, file))).toBe(true)
  expect(readFileSync(environmentFile, 'utf8')).not.toContain(token)
  expect(readFileSync(environmentFile, 'utf8')).not.toContain('GIT_CONFIG')
  expect(readFileSync(join(workingDirectory, '.git/config'), 'utf8')).not.toContain(token)
  expect(readFileSync(join(workingDirectory, '.git/config'), 'utf8')).not.toContain('extraHeader')
  await call('DELETE', `/api/conversations/${id}`)
  writeFileSync(join(workingDirectory, 'kept.txt'), 'work in progress')
  const resumed = await create({ ...launch, id: 'resumed' })
  expect((await call('GET', `/api/conversations/${resumed}`)).body).toMatchObject({ execution_status: 'idle' })
  expect(readFileSync(join(workingDirectory, 'kept.txt'), 'utf8')).toBe('work in progress')
})

test('a failing setup script shows its exit code and last output lines and the session still starts; a clone failure fails the launch', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => `echo line ${index + 1}`).join('\n')
  const url = bareRepository('broken', { '.hq/setup.sh': `${lines}\necho missing tool >&2\nexit 3\n` })
  const { call, open, create } = started()
  const id = await create(launchIn('broken', url).launch)
  const socket = open(id)
  await socket.until(kindOf('workspace'))
  const setupFailed = socket.events.find(kindOf('setup_failed'))
  expect(setupFailed?.completed).toBe(true)
  expect(setupFailed?.update).toEqual({
    sessionUpdate: 'setup_failed',
    exitCode: 3,
    output: [...Array.from({ length: 19 }, (_, index) => `line ${index + 7}`), 'missing tool'].join('\n'),
  })
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'idle' })
  const missing = await call(
    'POST',
    '/api/conversations',
    launchIn('missing', `file://${directory}/missing.git`).launch,
  )
  expect(missing.status).toBe(201)
  expect(missing.body).toMatchObject({ execution_status: 'error' })
  expect(String(missing.body.error)).toStartWith('The repository could not be cloned: ')
})
