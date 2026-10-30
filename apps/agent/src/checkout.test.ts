import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentEvent, createAgentTestbed, kindOf, textOf } from './testing.ts'

const { stubCommand, launchOf, started } = createAgentTestbed()
const directory = mkdtempSync(join(tmpdir(), 'spyria-agent-checkout-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const token = 'ghs_installation_token_never_kept'
const isSetup = (event: AgentEvent) => event.update.toolCallId === 'spyria-setup'
const setupEnded = (event: AgentEvent) => isSetup(event) && event.completed

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
  const repository = { url, token, base_branch: 'main', working_branch: 'spyria/fix-totals-1a2b3c' }
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

test('a launch with a repository clones it, checks out the working branch and runs the setup script once the agent started, as a command step; the token stays out of the agent and the repository config', async () => {
  const url = bareRepository('app', {
    'AGENTS.md': 'Rules',
    'src/AGENTS.md': 'Nested rules',
    '.spyria/setup.sh': 'echo prepared > prepared.txt',
  })
  const { call, open, create } = started()
  const { launch, workingDirectory, environmentFile } = launchIn('app', url)
  const id = await create(launch)
  const socket = open(id)
  await socket.until(kindOf('workspace'))
  expect(socket.events.find(kindOf('workspace'))?.update).toEqual({
    sessionUpdate: 'workspace',
    cwd: workingDirectory,
    branch: 'spyria/fix-totals-1a2b3c',
  })
  await socket.until(setupEnded)
  const setupEvents = socket.events.filter(isSetup).map(({ update }) => update)
  expect(socket.events.findIndex(isSetup)).toBeGreaterThan(socket.events.findIndex(kindOf('session_started')))
  expect(setupEvents.at(0)).toEqual({
    sessionUpdate: 'tool_call',
    toolCallId: 'spyria-setup',
    title: 'sh .spyria/setup.sh',
    kind: 'execute',
    status: 'in_progress',
  })
  expect(setupEvents.at(-1)).toMatchObject({ status: 'completed', rawOutput: { exit_code: 0 } })
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
  const resumedSocket = open(resumed)
  await resumedSocket.until(kindOf('workspace'))
  expect(resumedSocket.events.some(isSetup)).toBe(false)
})

test('a failing setup script shows its exit code and last output lines and the session still starts; a clone failure fails the launch', async () => {
  const lines = Array.from({ length: 25 }, (_, index) => `echo line ${index + 1}`).join('\n')
  const url = bareRepository('broken', { '.spyria/setup.sh': `${lines}\necho missing tool >&2\nexit 3\n` })
  const { call, open, create } = started()
  const id = await create(launchIn('broken', url).launch)
  const socket = open(id)
  await socket.until(kindOf('setup_failed'))
  expect(socket.events.filter(isSetup).at(-1)?.update).toMatchObject({
    status: 'failed',
    rawOutput: { exit_code: 3, formatted_output: expect.stringContaining('line 1\n') },
  })
  const setupFailed = socket.events.find(kindOf('setup_failed'))
  expect(setupFailed?.completed).toBe(true)
  expect(setupFailed?.update).toEqual({
    sessionUpdate: 'setup_failed',
    command: 'sh .spyria/setup.sh',
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

test('a slow setup script does not hold the launch: the session starts at once and the output streams as live updates', async () => {
  const url = bareRepository('slow', { '.spyria/setup.sh': 'echo installing\nsleep 1\necho installed\n' })
  const { call, open, create } = started()
  const startedAt = Date.now()
  const id = await create(launchIn('slow', url).launch)
  expect(Date.now() - startedAt).toBeLessThan(1000)
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'idle' })
  const socket = open(id)
  await socket.until(setupEnded)
  const updates = socket.events.filter(isSetup)
  expect(updates.find((event) => !event.completed && event.update.rawOutput)?.update.rawOutput).toEqual({
    formatted_output: 'installing\n',
  })
  expect(updates.at(-1)?.update.rawOutput).toEqual({ formatted_output: 'installing\ninstalled\n', exit_code: 0 })
})

test('a chatty setup script streams at most one live update per 250 ms, the latest output, and ends on the whole output', async () => {
  const script = 'for line in $(seq 1 30); do echo "line $line"; sleep 0.02; done\n'
  const url = bareRepository('chatty', { '.spyria/setup.sh': script })
  const { open, create } = started()
  const id = await create(launchIn('chatty', url).launch)
  const socket = open(id)
  await socket.until(setupEnded)
  const liveOutputs = socket.events
    .filter((event) => isSetup(event) && !event.completed && event.update.rawOutput)
    .map((event) => String((event.update.rawOutput as { formatted_output: string }).formatted_output))
  const wholeOutput = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join('')
  expect(liveOutputs[0]).toBe('line 1\n')
  expect(liveOutputs.length).toBeLessThan(10)
  expect(liveOutputs.every((output) => wholeOutput.startsWith(output))).toBe(true)
  expect(socket.events.filter(isSetup).at(-1)?.update.rawOutput).toEqual({
    formatted_output: wholeOutput,
    exit_code: 0,
  })
})

test('a launch with an author sets it as the repository’s commit identity, again on a resumed launch, and ignores an author with a line break', async () => {
  const url = bareRepository('authored', { 'README.md': '# authored\n' })
  const { create } = started()
  const { launch, workingDirectory } = launchIn('authored', url)
  const configured = (key: string) =>
    Bun.spawnSync(['git', 'config', '--local', key], { cwd: workingDirectory }).stdout.toString()
  const withAuthor = (author: object) => ({ ...launch, repository: { ...launch.repository, author } })
  await create({ ...withAuthor({ name: 'alice', email: '1+alice@users.noreply.github.com' }), id: 'authored' })
  expect(configured('user.name')).toBe('alice\n')
  expect(configured('user.email')).toBe('1+alice@users.noreply.github.com\n')
  writeFileSync(join(workingDirectory, 'notes.md'), 'notes\n')
  git(workingDirectory, 'add', 'notes.md')
  git(workingDirectory, 'commit', '-q', '-m', 'Add notes')
  expect(Bun.spawnSync(['git', 'log', '-1', '--format=%an|%ae|%cn'], { cwd: workingDirectory }).stdout.toString()).toBe(
    'alice|1+alice@users.noreply.github.com|alice\n',
  )

  await create({ ...withAuthor({ name: 'bob', email: '2+bob@users.noreply.github.com' }), id: 'reauthored' })
  expect(configured('user.name')).toBe('bob\n')
  await create({ ...withAuthor({ name: 'eve\n', email: 'eve@example.com' }), id: 'unauthored' })
  expect(configured('user.name')).toBe('bob\n')
})

test('a launch with a start branch builds the working branch on that branch when the remote has it, keeps its name when it is the same branch, and starts from the base otherwise', async () => {
  const url = bareRepository('forked', { 'README.md': '# forked\n' })
  const pushed = join(directory, 'forked-pushed')
  git(directory, 'clone', '-q', url, pushed)
  git(pushed, 'checkout', '-q', '-b', 'spyria/fix-totals-1a2b3c')
  writeFileSync(join(pushed, 'totals.ts'), 'export const total = 2\n')
  git(pushed, 'add', 'totals.ts')
  git(pushed, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'Fix totals')
  git(pushed, 'push', '-q', 'origin', 'spyria/fix-totals-1a2b3c')
  const { create } = started()
  const checkedOut = async (name: string, branches: { working_branch: string; start_branch: string }) => {
    const { launch, workingDirectory } = launchIn(name, url)
    await create({ ...launch, repository: { ...launch.repository, ...branches } })
    const read = (...command: string[]) =>
      Bun.spawnSync(['git', ...command], { cwd: workingDirectory })
        .stdout.toString()
        .trim()
    return { branch: read('branch', '--show-current'), hasFix: existsSync(join(workingDirectory, 'totals.ts')), read }
  }

  const fork = await checkedOut('fork', {
    working_branch: 'spyria/fix-totals-fork-0b1c2d',
    start_branch: 'spyria/fix-totals-1a2b3c',
  })
  expect(fork).toMatchObject({ branch: 'spyria/fix-totals-fork-0b1c2d', hasFix: true })
  expect(fork.read('config', '--get', 'branch.spyria/fix-totals-fork-0b1c2d.remote')).toBe('')
  expect(
    await checkedOut('same', { working_branch: 'spyria/fix-totals-1a2b3c', start_branch: 'spyria/fix-totals-1a2b3c' }),
  ).toMatchObject({ branch: 'spyria/fix-totals-1a2b3c', hasFix: true })
  expect(
    await checkedOut('unpushed', {
      working_branch: 'spyria/other-fork-3c4d5e',
      start_branch: 'spyria/never-pushed-9f8e7d',
    }),
  ).toMatchObject({ branch: 'spyria/other-fork-3c4d5e', hasFix: false })
})

const isAlive = (pid: number) => {
  const stat = `/proc/${pid}/stat`
  return existsSync(stat) && readFileSync(stat, 'utf8').split(') ')[1]?.[0] !== 'Z'
}

test('a setup script past its time limit is stopped with every process it started, and the notice gives the limit', async () => {
  const url = bareRepository('stuck', {
    '.spyria/setup.sh': 'echo downloading\nsleep 30 &\necho $! > sleep.pid\nwait\n',
  })
  const { open, create } = started({ setupTimeoutMilliseconds: 300 })
  const { launch, workingDirectory } = launchIn('stuck', url)
  const socket = open(await create(launch))
  await socket.until(kindOf('setup_failed'))
  expect(socket.events.filter(isSetup).at(-1)?.update).toMatchObject({
    status: 'failed',
    rawOutput: { formatted_output: 'downloading\n' },
  })
  expect(socket.events.filter(isSetup).at(-1)?.update.rawOutput).not.toHaveProperty('exit_code')
  expect(socket.events.find(kindOf('setup_failed'))?.update).toEqual({
    sessionUpdate: 'setup_failed',
    command: 'sh .spyria/setup.sh',
    timeoutMinutes: 0.005,
    output: 'downloading',
  })
  expect(isAlive(Number(readFileSync(join(workingDirectory, 'sleep.pid'), 'utf8')))).toBe(false)
})

test('a setup script that leaves a service running in the background ends when the script itself exits, and the service keeps running', async () => {
  const url = bareRepository('service', {
    '.spyria/setup.sh': 'sh -c "sleep 30" &\necho $! > service.pid\necho ready\n',
  })
  const { open, create } = started()
  const { launch, workingDirectory } = launchIn('service', url)
  const socket = open(await create(launch))
  await socket.until(setupEnded)
  expect(socket.events.filter(isSetup).at(-1)?.update.rawOutput).toEqual({ formatted_output: 'ready\n', exit_code: 0 })
  const servicePid = Number(readFileSync(join(workingDirectory, 'service.pid'), 'utf8'))
  expect(isAlive(servicePid)).toBe(true)
  process.kill(servicePid, 'SIGKILL')
})

test('a prompt sent while the setup script runs reaches the agent once setup ends; Stop while it waits ends the turn without reaching the agent', async () => {
  const url = bareRepository('waiting', { '.spyria/setup.sh': 'sleep 1\necho ready\n' })
  const { call, open, create, prompt } = started()
  const { launch } = launchIn('waiting', url)
  const id = await create(launch)
  const socket = open(id)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  const setupEndIndex = socket.events.findIndex(setupEnded)
  expect(setupEndIndex).toBeGreaterThan(-1)
  expect(socket.events.findIndex(kindOf('agent_message_chunk'))).toBeGreaterThan(setupEndIndex)

  const stopped = await create({
    ...launch,
    workspace: { working_dir: join(directory, 'waiting-stopped') },
    id: 'stopped',
  })
  const stoppedSocket = open(stopped)
  await prompt(stopped, 'hello')
  expect((await call('POST', `/api/conversations/${stopped}/interrupt`, {})).status).toBe(200)
  await stoppedSocket.until(kindOf('turn_end'))
  expect(stoppedSocket.events.find(kindOf('turn_end'))?.update.stopReason).toBe('cancelled')
  expect(stoppedSocket.events.some(setupEnded)).toBe(false)
  await stoppedSocket.until(setupEnded)
  await prompt(stopped, 'again')
  await stoppedSocket.until(kindOf('turn_end'), 2)
  expect(textOf(stoppedSocket.events)).toStartWith('[t1] ')
})

test('a conversation created again while the setup script runs shows the running setup, its end and its notice, and its prompt waits for it', async () => {
  const url = bareRepository('recreated', { '.spyria/setup.sh': 'echo installing\nsleep 1\nexit 4\n' })
  const { call, open, create, prompt } = started()
  const { launch } = launchIn('recreated', url)
  const first = await create({ ...launch, id: 'first' })
  await open(first).until(isSetup)
  await call('DELETE', `/api/conversations/${first}`)
  const again = await create({ ...launch, id: 'again' })
  const socket = open(again)
  await prompt(again, 'hello')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.find(isSetup)?.update).toMatchObject({ sessionUpdate: 'tool_call', status: 'in_progress' })
  expect(socket.events.filter(isSetup).at(-1)?.update).toMatchObject({ status: 'failed', rawOutput: { exit_code: 4 } })
  expect(socket.events.find(kindOf('setup_failed'))?.update).toMatchObject({ exitCode: 4 })
  expect(socket.events.findIndex(kindOf('agent_message_chunk'))).toBeGreaterThan(socket.events.findIndex(setupEnded))
  expect(socket.events.filter((event) => isSetup(event) && event.update.sessionUpdate === 'tool_call')).toHaveLength(1)
})

test('a restarted runtime runs the setup script again on its existing clone', async () => {
  const url = bareRepository('restarted', { '.spyria/setup.sh': 'echo run >> runs.txt\n' })
  const { launch, workingDirectory } = launchIn('restarted', url)
  for (const id of ['before-restart', 'after-restart']) {
    const { open, create } = started()
    await open(await create({ ...launch, id })).until(setupEnded)
  }
  expect(readFileSync(join(workingDirectory, 'runs.txt'), 'utf8')).toBe('run\nrun\n')
})

test('a setup command given with the repository runs instead of .spyria/setup.sh, and its step and notice name it', async () => {
  const url = bareRepository('configured', { '.spyria/setup.sh': 'echo from the file > from-file.txt\n' })
  const { open, create } = started()
  const { launch, workingDirectory } = launchIn('configured', url)
  const repository = { ...launch.repository, setup_command: 'echo configured > configured.txt && exit 5' }
  const socket = open(await create({ ...launch, repository }))
  await socket.until(kindOf('setup_failed'))
  expect(socket.events.find(isSetup)?.update).toMatchObject({ title: 'echo configured > configured.txt && exit 5' })
  expect(socket.events.find(kindOf('setup_failed'))?.update).toEqual({
    sessionUpdate: 'setup_failed',
    command: 'echo configured > configured.txt && exit 5',
    exitCode: 5,
    output: '',
  })
  expect(existsSync(join(workingDirectory, 'configured.txt'))).toBe(true)
  expect(existsSync(join(workingDirectory, 'from-file.txt'))).toBe(false)
})
