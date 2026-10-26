import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lineReaderOf } from './acp.ts'
import { formShapes, startAgent } from './agent.ts'
import { startTelemetry } from './telemetry.ts'
import {
  type AgentEvent,
  apiKey,
  clientOf,
  createAgentTestbed,
  kindOf,
  piHello,
  questionAt,
  textOf,
} from './testing.ts'

const { stateDirectory, stubCommand, launchOf, piLaunchOf, running, started } = createAgentTestbed()

test('a prompt streams chunks and ends its turn; Stop cancels the next turn and the session continues', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf({ acp_model: 'stub-large' }))
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ id, execution_status: 'idle' })
  const socket = open(id)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  expect(textOf(socket.events)).toBe('[t1] Hello from the stub (model stub-large, mode bypassPermissions).')
  expect(socket.events.find(kindOf('session_started'))?.update).toMatchObject({ resumeFailed: false })
  expect(socket.events.find(kindOf('turn_end'))).toMatchObject({ completed: true, update: { stopReason: 'end_turn' } })
  expect(socket.events.filter(kindOf('agent_message_chunk')).every((event) => !event.completed)).toBe(true)
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'finished' })

  await prompt(id, 'stub:long')
  await socket.until((event) => event.update.status === 'in_progress')
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'running' })
  expect((await call('POST', `/api/conversations/${id}/interrupt`, {})).status).toBe(200)
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.filter(kindOf('turn_end')).at(-1)?.update.stopReason).toBe('cancelled')

  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'stub-default' })
  await prompt(id, 'again')
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events)).toEndWith('[t3] Hello from the stub (model stub-default, mode bypassPermissions).')
  expect(socket.events.filter(kindOf('config_option_update'))).toHaveLength(2)
  expect((await call('DELETE', `/api/conversations/${id}`)).status).toBe(200)
  expect((await call('GET', `/api/conversations/${id}`)).status).toBe(404)
})

test('events are numbered per conversation, resent after a sequence number, from a bounded buffer', async () => {
  const { open, create, prompt } = started({ bufferSize: 4 })
  const id = await create(launchOf())
  const live = open(id)
  await prompt(id, 'stub:think')
  const events = await live.until(kindOf('turn_end'))
  expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1))
  expect(events.map(({ id: eventId }) => eventId)).toEqual(events.map(({ seq }) => `${id}:${seq}`))
  expect(events.filter(kindOf('agent_thought_chunk')).map(({ completed }) => completed)).toEqual([false, false])

  const lastSeq = events.length
  const workspaceSeq = Number(events.find(kindOf('workspace'))?.seq)
  const resent = open(id, lastSeq - 2)
  await resent.until(kindOf('turn_end'))
  expect(resent.events.map(({ seq }) => seq)).toEqual([workspaceSeq, lastSeq - 1, lastSeq])
  const everything = open(id)
  await everything.until(kindOf('turn_end'))
  expect(everything.events.map(({ seq }) => seq)).toEqual([lastSeq - 3, lastSeq - 2, lastSeq - 1, lastSeq])

  const intruder = open(id, 0, 'wrong-key')
  expect(await intruder.closed).toBe(1008)
  expect(intruder.events).toEqual([])
})

test('the replay buffer is also capped by bytes: it keeps the newest events that fit, and at least the last one', async () => {
  const { open, create, prompt } = started({ bufferBytes: 1500 })
  const id = await create(launchOf())
  const live = open(id)
  await prompt(id, 'stub:think')
  const events = await live.until(kindOf('turn_end'))
  const bytesOf = (event: AgentEvent) => Buffer.byteLength(JSON.stringify(event))
  const kept = events.filter((_, index) => events.slice(index).reduce((sum, event) => sum + bytesOf(event), 0) <= 1500)
  expect(kept.length).toBeGreaterThan(0)
  expect(kept.length).toBeLessThan(events.length)
  const replayed = open(id)
  await replayed.until(kindOf('turn_end'))
  expect(replayed.events.filter((event) => !kindOf('workspace')(event))).toEqual(
    kept.filter((event) => !kindOf('workspace')(event)),
  )

  const tiny = started({ bufferBytes: 1 })
  const tinyId = await tiny.create(launchOf())
  const tinyLive = tiny.open(tinyId)
  await tiny.prompt(tinyId, 'hello')
  const tinyEvents = await tinyLive.until(kindOf('turn_end'))
  const tinyReplay = tiny.open(tinyId)
  await tinyReplay.until(kindOf('turn_end'))
  expect(tinyReplay.events.filter((event) => !kindOf('workspace')(event))).toEqual(tinyEvents.slice(-1))
})

test('adapter lines are cut at every newline across chunks: carriage returns and empty lines kept, a last line without newline waits', () => {
  const lines: string[] = []
  const read = lineReaderOf((line) => lines.push(line))
  for (const chunk of ['{"a":1}\r\n{"b"', ':2}', '\n\n', '{"c":', '3}\n{"d":4}']) read(chunk)
  expect(lines).toEqual(['{"a":1}\r', '{"b":2}', '', '{"c":3}'])
  read('\n')
  expect(lines.at(-1)).toBe('{"d":4}')
  const longLine = JSON.stringify({ text: 'x'.repeat(20 * 1024 * 1024) })
  const startedAt = performance.now()
  for (let start = 0; start < longLine.length; start += 64 * 1024) read(longLine.slice(start, start + 64 * 1024))
  read('\n')
  expect(performance.now() - startedAt).toBeLessThan(150)
  expect(lines.at(-1)).toBe(longLine)
})

test('the final tool call update carries the merged call; turn ends and adapter errors are events', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  await prompt(id, 'stub:tools')
  await socket.until(kindOf('turn_end'))
  const finals = socket.events.filter((event) => kindOf('tool_call_update')(event) && event.completed)
  expect(finals.map(({ update }) => update)).toEqual([
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-1',
      title: 'Edit app.ts',
      kind: 'edit',
      status: 'completed',
      rawInput: { file_path: '/workspace/project/app.ts', old_string: 'one', new_string: 'two' },
      locations: [{ path: '/workspace/project/app.ts' }],
      content: [{ type: 'diff', path: '/workspace/project/app.ts', oldText: 'one', newText: 'two' }],
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'command-1',
      title: 'npm test',
      kind: 'execute',
      status: 'failed',
      rawInput: { command: 'npm test' },
      rawOutput: 'exit code 1',
      content: [{ type: 'content', content: { type: 'text', text: 'Tests failed' } }],
    },
  ])
  expect(socket.events.filter(kindOf('tool_call')).every((event) => !event.completed)).toBe(true)
  expect(textOf(socket.events)).toContain('permission:allow-always')

  await prompt(id, 'stub:fail')
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.slice(-2).map(({ update, completed }) => ({ update, completed }))).toEqual([
    { update: { sessionUpdate: 'error', message: 'Authentication required', code: -32000 }, completed: true },
    { update: { sessionUpdate: 'turn_end', stopReason: 'error' }, completed: true },
  ])

  await prompt(id, 'stub:crash')
  await socket.until(kindOf('turn_end'), 3)
  expect(socket.events.slice(-2).map(({ update }) => update)).toEqual([
    { sessionUpdate: 'error', message: 'The adapter exited with code 3' },
    { sessionUpdate: 'turn_end', stopReason: 'error' },
  ])
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'error' })
  expect((await prompt(id, 'after the crash')).status).toBe(409)

  const failing = await call('POST', '/api/conversations', {
    ...launchOf(),
    agent: { acp_command: ['env', 'STUB_FAIL_START=1', ...stubCommand.slice(1)] },
  })
  expect(failing.body).toMatchObject({ execution_status: 'error', error: 'Authentication required' })

  const missing = await create({ ...launchOf(), agent: { acp_command: ['spyria-agent-no-such-adapter'] } })
  expect((await call('GET', `/api/conversations/${missing}`)).body).toMatchObject({ execution_status: 'error' })
  const failedStart = open(missing)
  await failedStart.until(kindOf('error'))
  expect(failedStart.events.map(({ update }) => update.sessionUpdate)).toEqual(['error'])
})

test('a create with a known id returns that conversation without a second adapter, a new id starts its own, a malformed id is refused', async () => {
  const { call, open, prompt } = started()
  const launches = join(stateDirectory, `launches-${crypto.randomUUID()}`)
  const launch = launchOf({
    acp_command: ['sh', '-c', `echo launched >> ${launches}; exec "$@"`, 'sh', ...stubCommand],
  })
  const launchCount = async () => (await Bun.file(launches).text()).trim().split('\n').length
  const id = crypto.randomUUID()
  const [first, retried] = await Promise.all([
    call('POST', '/api/conversations', { ...launch, id }),
    Bun.sleep(5).then(() => call('POST', '/api/conversations', { ...launch, id })),
  ])
  expect(first).toMatchObject({ status: 201, body: { id, execution_status: 'idle' } })
  expect(retried).toMatchObject({ status: 200, body: { id, execution_status: 'idle' } })
  expect((await call('POST', '/api/conversations', { ...launch, id })).body).toEqual(first.body)
  expect(await launchCount()).toBe(1)
  const socket = open(id)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.filter(kindOf('session_started'))).toHaveLength(1)

  const other = await call('POST', '/api/conversations', { ...launch, id: crypto.randomUUID() })
  expect(other.status).toBe(201)
  expect(other.body.id).not.toBe(id)
  expect(await launchCount()).toBe(2)
  expect((await call('POST', '/api/conversations', { ...launch, id: '../x' })).status).toBe(400)
})

test('the workspace is reported at session start and after a turn only when it changed: no branch without git, then the branch; resent on reconnect', async () => {
  const { open, create, prompt } = started()
  const workingDirectory = mkdtempSync(join(tmpdir(), 'spyria-agent-workspace-'))
  const id = await create({ ...launchOf(), workspace: { working_dir: workingDirectory } })
  const socket = open(id)
  const turns = [
    { text: 'hello', workspaces: 1 },
    { text: 'stub:branch feature/plan', workspaces: 2 },
    { text: 'again', workspaces: 2 },
    { text: 'stub:branch fix/totals', workspaces: 3 },
  ]
  for (const [index, { text, workspaces }] of turns.entries()) {
    await prompt(id, text)
    await socket.until(kindOf('turn_end'), index + 1)
    await socket.until(kindOf('workspace'), workspaces)
  }
  const workspaceOf = (branch?: string) => ({
    sessionUpdate: 'workspace',
    cwd: workingDirectory,
    ...(branch && { branch }),
  })
  expect(
    socket.events
      .filter((event) => kindOf('workspace')(event) || kindOf('turn_end')(event))
      .map(({ update, completed }) => (update.sessionUpdate === 'turn_end' ? 'turn_end' : { update, completed })),
  ).toEqual([
    { update: workspaceOf(), completed: false },
    'turn_end',
    'turn_end',
    { update: workspaceOf('feature/plan'), completed: false },
    'turn_end',
    'turn_end',
    { update: workspaceOf('fix/totals'), completed: false },
  ])
  const reopened = open(id, socket.events.at(-1)?.seq)
  await reopened.until(kindOf('workspace'))
  expect(reopened.events.map(({ update }) => update)).toEqual([workspaceOf('fix/totals')])
  rmSync(workingDirectory, { recursive: true, force: true })
})

test('a subscription launch gets no gateway URL and no key, spyria-agent never logs environment values, and its own children never see its session key', async () => {
  const secretValues = ['inherited-anthropic-key-0001', 'http://gateway.invalid/v1', 'sk-spyria-llm-token-0002', apiKey]
  const fakeGitDirectory = mkdtempSync(join(tmpdir(), 'spyria-agent-git-'))
  const gitEnvironmentPath = join(fakeGitDirectory, 'environment')
  writeFileSync(join(fakeGitDirectory, 'git'), `#!/bin/sh\nenv > ${gitEnvironmentPath}\nexit 1\n`, { mode: 0o755 })
  const child = Bun.spawn(['bun', new URL('./main.ts', import.meta.url).pathname], {
    env: {
      PATH: `${fakeGitDirectory}:${process.env.PATH}`,
      HOME: String(process.env.HOME),
      PORT: '0',
      OH_SESSION_API_KEYS_0: apiKey,
      ANTHROPIC_API_KEY: 'inherited-anthropic-key-0001',
      ANTHROPIC_BASE_URL: 'http://gateway.invalid/v1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const reader = child.stdout.getReader()
  let output = ''
  while (!/"server.port":(\d+)/.test(output)) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`spyria-agent did not start: ${output}`)
    output += new TextDecoder().decode(value)
  }
  const { open, create, prompt } = clientOf(Number(/"server.port":(\d+)/.exec(output)?.[1]))
  try {
    const envOf = async (launch: object) => {
      const id = await create(launch)
      const socket = open(id)
      await prompt(id, 'stub:env')
      await socket.until(kindOf('turn_end'))
      return JSON.parse(/env:(\[.*?\])/.exec(textOf(socket.events))?.[1] ?? '[]') as string[]
    }
    const subscriptionCommand = ['env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', ...stubCommand]
    const subscription = await envOf(launchOf({ acp_command: subscriptionCommand }))
    expect(subscription).toContain('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    expect(subscription.filter((name) => /ANTHROPIC|OPENAI|BASE_URL|SESSION_API|KEY|TOKEN/.test(name))).toEqual([])
    const apiKeyLaunch = await envOf(
      launchOf(
        { acp_command: ['env', 'ANTHROPIC_BASE_URL=http://gateway.invalid', ...stubCommand] },
        { ANTHROPIC_API_KEY: { kind: 'StaticSecret', value: 'sk-spyria-llm-token-0002' } },
      ),
    )
    expect(apiKeyLaunch).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']))
    await create({
      ...launchOf({ acp_command: ['spyria-agent-no-such-adapter'] }),
      secrets: { X: { value: 'sk-spyria-llm-token-0002' } },
    })
  } finally {
    child.kill()
  }
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    output += new TextDecoder().decode(chunk.value)
  const logs = output + (await new Response(child.stderr).text())
  expect(logs).toContain('"event.name":"agent.listening"')
  for (const value of secretValues) expect(logs).not.toContain(value)
  const gitEnvironment = readFileSync(gitEnvironmentPath, 'utf8')
  rmSync(fakeGitDirectory, { recursive: true, force: true })
  expect(gitEnvironment).toContain('PATH=')
  expect(gitEnvironment).not.toContain('OH_SESSION_API_KEYS_0')
  expect(gitEnvironment).not.toContain(apiKey)
})

test('a new spyria-agent resumes the session of an earlier one, and a missing session falls back to a new one', async () => {
  const first = started()
  const id = await first.create(launchOf())
  const socket = first.open(id)
  await first.prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  const sessionId = String(socket.events.find(kindOf('session_started'))?.update.sessionId)
  first.agent.stop()

  const second = started()
  const resumedId = await second.create(launchOf({ acp_resume_session_id: sessionId }))
  expect((await second.call('GET', `/api/conversations/${resumedId}`)).body).toMatchObject({
    acp_session_id: sessionId,
  })
  const resumed = second.open(resumedId)
  await second.prompt(resumedId, 'hello again')
  await resumed.until(kindOf('turn_end'))
  expect(resumed.events.find(kindOf('session_started'))?.update).toMatchObject({ sessionId, resumeFailed: false })
  expect(textOf(resumed.events)).toStartWith('[t2]')

  const fallbackId = await second.create(launchOf({ acp_resume_session_id: crypto.randomUUID() }))
  const fallback = second.open(fallbackId)
  const [start] = await fallback.until(kindOf('session_started'))
  expect(start?.update).toMatchObject({ resumeFailed: true })
  expect(start?.update.sessionId).not.toBe(sessionId)
})

test("an ACP harness whose Claude process dies mid-turn is restarted: the turn ends with a notice, the next prompt keeps the session, and the adapter's error output is logged redacted", async () => {
  const lines: Record<string, unknown>[] = []
  const telemetry = startTelemetry({ write: (line) => void lines.push(JSON.parse(line)) })
  try {
    const { call, open, create, prompt } = started()
    const id = await create(
      launchOf({ acp_model: 'stub-large' }, { CLAUDE_CODE_OAUTH_TOKEN: { value: 'subscription-token-0003' } }),
    )
    const socket = open(id)
    await prompt(id, 'hello')
    await socket.until(kindOf('turn_end'))
    await prompt(id, 'stub:die')
    await socket.until(kindOf('turn_end'), 2)
    expect(socket.events.filter(kindOf('error')).map(({ update }) => update.message)).toEqual([
      'The agent restarted; send your message again. It reported: Claude Code process exited with code 1',
    ])
    expect(socket.events.filter(kindOf('turn_end')).at(-1)?.update.stopReason).toBe('error')
    const [first, reloaded] = socket.events.filter(kindOf('session_started'))
    expect(reloaded?.update).toMatchObject({ sessionId: first?.update.sessionId, resumeFailed: false })
    expect(textOf(socket.events)).not.toContain('REPLAYED')
    expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'finished' })

    await prompt(id, 'hello again')
    await socket.until(kindOf('turn_end'), 3)
    expect(textOf(socket.events)).toEndWith('[t3] Hello from the stub (model stub-large, mode bypassPermissions).')

    const failure = lines.find((line) => line['event.name'] === 'agent.adapter_failed')
    expect(failure?.['conversation.id']).toBe(id)
    expect(String(failure?.['adapter.error_output']).split('\n')).toEqual([
      'Claude Code started with [redacted]',
      'retrying with [redacted]',
      'Claude Code process exited with code 1',
    ])
    expect(JSON.stringify(lines)).not.toContain('subscription-token-0003')
    expect(JSON.stringify(lines)).not.toContain('sk-ant-oat01-stubtoken')
    expect(JSON.stringify(socket.events)).not.toContain('subscription-token-0003')
  } finally {
    await telemetry.shutdown()
  }
})

test('a session found dead before any output is restarted and the prompt is sent once more', async () => {
  const { open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  await prompt(id, 'stub:die-early')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.filter(kindOf('error'))).toEqual([])
  expect(socket.events.find(kindOf('turn_end'))?.update.stopReason).toBe('end_turn')
  expect(textOf(socket.events)).toBe('[t2] Hello from the stub (model stub-default, mode bypassPermissions).')
  expect(socket.events.filter(kindOf('session_started'))).toHaveLength(2)
})

test('restart ends a running turn and reloads the session; it also brings back a conversation whose adapter exited', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  await prompt(id, 'stub:long')
  await socket.until((event) => event.update.status === 'in_progress')
  const restarted = await call('POST', `/api/conversations/${id}/restart`, {})
  expect(restarted).toMatchObject({ status: 200, body: { id, execution_status: 'idle' } })
  await socket.until(kindOf('turn_end'))
  expect(socket.events.find(kindOf('turn_end'))?.update.stopReason).toBe('cancelled')

  await prompt(id, 'stub:crash')
  await socket.until(kindOf('turn_end'), 2)
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'error' })
  expect((await call('POST', `/api/conversations/${id}/restart`, {})).body).toMatchObject({ execution_status: 'idle' })
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events)).toEndWith('[t3] Hello from the stub (model stub-default, mode bypassPermissions).')
  const sessionIds = socket.events.filter(kindOf('session_started')).map(({ update }) => update.sessionId)
  expect(new Set(sessionIds).size).toBe(1)
  expect(sessionIds).toHaveLength(3)
})

const isAlive = (pid: number) => {
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

test.each([
  ['an ACP adapter', 'session/new', () => launchOf()],
  ['Pi', 'get_state', () => piLaunchOf()],
])(
  '%s that never answers %s is stopped after the request timeout and its conversation fails',
  async (_, method, launch) => {
    const { call } = started({ requestTimeoutMilliseconds: 300 })
    const silentLaunch = launch()
    silentLaunch.agent.acp_command = ['env', `STUB_SILENT=${method}`, ...(silentLaunch.agent.acp_command as string[])]
    const { status, body } = await call('POST', '/api/conversations', silentLaunch)
    expect(status).toBe(201)
    const timedOut = method === 'get_state' ? 'session/new' : method
    expect(body).toMatchObject({
      execution_status: 'error',
      error: `The adapter did not answer ${timedOut} within 300 ms`,
    })
    const pid = Number(readFileSync(join(stateDirectory, 'silent.pid'), 'utf8'))
    for (const deadline = Date.now() + 5_000; isAlive(pid) && Date.now() < deadline; ) await Bun.sleep(10)
    expect(isAlive(pid)).toBe(false)
  },
)

test.each([
  [
    'an ACP adapter',
    () => launchOf(),
    (turn: number) => `[t${turn}] Hello from the stub (model stub-default, mode bypassPermissions).`,
  ],
  ['Pi', () => piLaunchOf(), (turn: number) => piHello(turn)],
])('with %s, a prompt sent while a turn runs waits for it and gets its own turn end', async (_, launch, hello) => {
  const { call, open, create, prompt } = started()
  const id = await create(launch())
  const socket = open(id)
  await prompt(id, 'stub:linger first')
  expect((await call('GET', `/api/conversations/${id}`)).body).toMatchObject({ execution_status: 'running' })
  await prompt(id, 'second')
  await socket.until(kindOf('turn_end'), 2)
  const firstTurnEnd = socket.events.findIndex(kindOf('turn_end'))
  expect(textOf(socket.events.slice(0, firstTurnEnd))).toBe(hello(1))
  expect(textOf(socket.events.slice(firstTurnEnd))).toBe(hello(2))
  expect(socket.events.filter(kindOf('turn_end')).map(({ update }) => update.stopReason)).toEqual([
    'end_turn',
    'end_turn',
  ])
})

test('requests without the session key are refused, /ready is open, a socket that never authenticates is closed', async () => {
  const agent = startAgent({ apiKey, port: 0, authTimeoutMilliseconds: 100 })
  running.push(agent)
  const { call, create } = clientOf(agent.port)
  expect((await call('GET', '/ready', undefined, '')).status).toBe(200)
  expect((await call('POST', '/api/conversations', launchOf(), 'wrong')).status).toBe(401)
  expect((await call('POST', '/api/conversations', launchOf(), apiKey.replace(/.$/, 'x'))).status).toBe(401)
  const silent = new WebSocket(`ws://localhost:${agent.port}/sockets/events/${await create(launchOf())}`)
  const closed = new Promise((resolve) => silent.addEventListener('close', (event) => resolve(event.code)))
  expect(await Promise.race([closed, Bun.sleep(2_000).then(() => 'still open')])).toBe(1008)
  expect((await call('POST', '/api/conversations', { agent: { acp_command: 'node' } })).status).toBe(400)
})

const answerOf = (events: AgentEvent[]) => JSON.parse(/answer:(\{.*?\}) /.exec(textOf(events))?.[1] ?? 'null')

test('a Claude Code question waits for an answer: a pick, a free answer and a skip reach the adapter in its field names', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  const answerTo = (questionId: string, body: object) =>
    call('POST', `/api/conversations/${id}/questions/${questionId}`, body)

  await prompt(id, 'stub:ask')
  const questionId = await questionAt(socket, 1)
  const question = {
    questionId,
    toolCallId: 'ask-1',
    kind: 'question',
    questions: [
      {
        id: 'question_0',
        header: 'Database',
        text: 'Which database should we use?',
        options: [
          { value: 'Postgres', label: 'Postgres', description: 'Relational' },
          { value: 'SQLite', label: 'SQLite', description: 'Embedded' },
        ],
        multi: false,
        free: true,
      },
    ],
  }
  expect(socket.events.find(kindOf('question'))).toMatchObject({
    completed: false,
    update: { sessionUpdate: 'question', ...question },
  })
  expect((await answerTo(questionId, { approve: true })).status).toBe(400)
  expect((await answerTo(questionId, { answers: { question_0: 'SQLite' }, answeredBy: 'member-1' })).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(answerOf(socket.events)).toEqual({ action: 'accept', content: { question_0: 'SQLite' } })
  expect(socket.events.find(kindOf('question_answered'))).toMatchObject({
    completed: true,
    update: {
      sessionUpdate: 'question_answered',
      ...question,
      answers: { question_0: 'SQLite' },
      answeredBy: 'member-1',
    },
  })
  expect((await answerTo(questionId, { answers: { question_0: 'Postgres' } })).status).toBe(409)

  await prompt(id, 'stub:ask')
  expect((await answerTo(await questionAt(socket, 2), { answers: {}, free: { question_0: 'MySQL' } })).status).toBe(200)
  await socket.until(kindOf('turn_end'), 2)
  expect(answerOf(socket.events.slice(-4))).toEqual({ action: 'accept', content: { question_0_custom: 'MySQL' } })
  expect(socket.events.filter(kindOf('question_answered')).at(-1)?.update).toMatchObject({
    answers: {},
    free: { question_0: 'MySQL' },
  })

  await prompt(id, 'stub:ask')
  await answerTo(await questionAt(socket, 3), { answers: {} })
  await socket.until(kindOf('turn_end'), 3)
  expect(answerOf(socket.events.slice(-4))).toEqual({ action: 'decline' })
})

test('a Codex form of three questions is normalized and a free answer picks "None of the above" with its note', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  await prompt(id, 'stub:ask-codex')
  const questionId = await questionAt(socket, 1)
  expect(socket.events.find(kindOf('question'))?.update.questions).toEqual([
    {
      id: 'db',
      header: 'Database',
      text: 'Which database should I use?',
      options: [
        { value: 'Postgres', label: 'Postgres', description: 'Relational' },
        { value: 'SQLite', label: 'SQLite', description: 'File' },
      ],
      multi: false,
      free: true,
    },
    {
      id: 'lang',
      header: 'Language',
      text: 'Which language?',
      options: [
        { value: 'TypeScript', label: 'TypeScript' },
        { value: 'Go', label: 'Go' },
      ],
      multi: false,
      free: true,
    },
    {
      id: 'ci',
      header: 'CI',
      text: 'Which CI?',
      options: [
        { value: 'GitHub Actions', label: 'GitHub Actions' },
        { value: 'None', label: 'None' },
      ],
      multi: false,
      free: true,
    },
  ])
  await call('POST', `/api/conversations/${id}/questions/${questionId}`, {
    answers: { db: 'SQLite', lang: 'Go' },
    free: { lang: 'Go 1.26', ci: 'CircleCI' },
  })
  await socket.until(kindOf('turn_end'))
  expect(answerOf(socket.events)).toEqual({
    action: 'accept',
    content: { db: 'SQLite', lang: 'Go', lang_note: 'Go 1.26', ci: 'None of the above', ci_note: 'CircleCI' },
  })
})

test('Stop, the adapter withdrawing the request and the turn end close a waiting question; late answers are refused', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  await prompt(id, 'stub:ask')
  const questionId = await questionAt(socket, 1)
  expect((await call('POST', `/api/conversations/${id}/interrupt`, {})).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(socket.events.find(kindOf('question_closed'))).toMatchObject({
    completed: true,
    update: { sessionUpdate: 'question_closed', questionId, kind: 'question', reason: 'stopped' },
  })
  expect(socket.events.findLast(kindOf('turn_end'))?.update).toEqual({
    sessionUpdate: 'turn_end',
    stopReason: 'cancelled',
  })
  const late = await call('POST', `/api/conversations/${id}/questions/${questionId}`, {
    answers: { question_0: 'SQLite' },
  })
  expect(late.status).toBe(409)

  await prompt(id, 'stub:ask stub:withdraw')
  const withdrawn = await questionAt(socket, 2)
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.filter(kindOf('question_closed')).at(-1)?.update).toMatchObject({
    questionId: withdrawn,
    reason: 'cancelled',
  })
  expect(answerOf(socket.events.slice(-4))).toEqual({ action: 'cancel' })
  expect(socket.events.findLast(kindOf('turn_end'))?.update.stopReason).toBe('end_turn')

  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events)).toEndWith('[t3] Hello from the stub (model stub-default, mode bypassPermissions).')
})

test('plan approval: approve and keep planning map to the Claude Code and Codex options; plan mode refuses writes', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(launchOf())
  const socket = open(id)
  const decide = async (text: string, approve: boolean, turns: number) => {
    const asked = socket.events.filter(kindOf('question')).length + 1
    await prompt(id, text)
    const questionId = await questionAt(socket, asked)
    expect((await call('POST', `/api/conversations/${id}/questions/${questionId}`, { approve })).status).toBe(200)
    await socket.until(kindOf('turn_end'), turns)
    return socket.events.slice(socket.events.findLastIndex(kindOf('question')))
  }

  const kept = await decide('stub:exit-plan', false, 1)
  expect(kept[0]?.update).toMatchObject({ kind: 'plan', toolCallId: 'exit-plan-1', plan: '1. Create x.txt\n2. Done' })
  expect(kept.find(kindOf('question_answered'))?.update).toMatchObject({ kind: 'plan', approved: false })
  expect(textOf(kept)).toBe('plan:reject ')
  expect(kept.find(kindOf('turn_end'))?.update).toEqual({
    sessionUpdate: 'turn_end',
    stopReason: 'cancelled',
    keptPlanning: true,
  })

  await prompt(id, 'stub:write stub:read')
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events.slice(-6))).toContain('write:reject ')
  expect(socket.events.findLast((event) => event.update.toolCallId === 'read-2')?.update.status).toBe('completed')

  const approved = await decide('stub:exit-plan', true, 3)
  expect(textOf(approved)).toBe(
    'plan:exit-plan-bypass Hello from the stub (model stub-default, mode bypassPermissions).',
  )
  expect(approved.find(kindOf('turn_end'))?.update).toEqual({ sessionUpdate: 'turn_end', stopReason: 'end_turn' })
  await prompt(id, 'stub:write')
  await socket.until(kindOf('turn_end'), 4)
  expect(textOf(socket.events.slice(-4))).toContain('write:allow-once ')

  const codexApproved = await decide('stub:plan-codex', true, 5)
  expect(codexApproved[0]?.update).toMatchObject({ kind: 'plan', plan: '1. Create x.txt\n2. Done' })
  expect(textOf(codexApproved)).toStartWith('plan:implement_plan ')
  const revised = await decide('stub:plan-codex', false, 6)
  expect(textOf(revised)).toStartWith('plan:revise_plan ')
  expect(revised.find(kindOf('turn_end'))?.update).toEqual({ sessionUpdate: 'turn_end', stopReason: 'end_turn' })
})

test("the plan mode route sets Claude Code's mode and back, Codex's collaboration mode, and refuses an agent without either", async () => {
  const { call, open, create, prompt } = started()
  const planMode = (id: string, enabled: unknown) => call('POST', `/api/conversations/${id}/plan_mode`, { enabled })
  const claude = await create(launchOf())
  const socket = open(claude)
  expect((await planMode(claude, 'yes')).status).toBe(400)
  expect((await planMode(claude, true)).status).toBe(200)
  await prompt(claude, 'stub:write')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.find(kindOf('current_mode_update'))).toMatchObject({
    completed: true,
    update: { currentModeId: 'plan' },
  })
  expect(textOf(socket.events)).toBe('[t1] write:reject Hello from the stub (model stub-default, mode plan).')
  expect((await planMode(claude, false)).status).toBe(200)
  await prompt(claude, 'stub:write')
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.filter(kindOf('current_mode_update')).at(-1)?.update.currentModeId).toBe('bypassPermissions')
  expect(textOf(socket.events.slice(-5))).toContain(
    'write:allow-once Hello from the stub (model stub-default, mode bypassPermissions).',
  )

  const codex = await create(launchOf({ acp_command: ['env', 'STUB_FLAVOUR=codex', ...stubCommand.slice(1)] }))
  const codexSocket = open(codex)
  expect((await planMode(codex, true)).status).toBe(200)
  const collaborationOf = (events: AgentEvent[]) =>
    (
      events.findLast(kindOf('config_option_update'))?.update.configOptions as
        | { id: string; currentValue: string }[]
        | undefined
    )?.find((option) => option.id === 'collaboration_mode')?.currentValue
  expect(collaborationOf(await codexSocket.until(kindOf('config_option_update')))).toBe('plan')
  expect((await planMode(codex, false)).status).toBe(200)
  expect(collaborationOf(await codexSocket.until(kindOf('config_option_update'), 2))).toBe('default')

  const modes = 'STUB_MODES=read-only,agent-full-access'
  const neither = await create(launchOf({ acp_command: ['env', modes, ...stubCommand.slice(1)] }))
  expect((await planMode(neither, true)).status).toBe(409)
})

test.each([
  ['Claude Code', [], 'max', 'low'],
  ['Codex', ['STUB_FLAVOUR=codex'], 'high', 'xhigh'],
])(
  '%s effort: a launch with only a thought level sets it, a switch with only a thought level changes it on the same session, an unlisted level is ignored',
  async (_tool, flavour, launched, switched) => {
    const { call, open, create, prompt } = started()
    const id = await create(
      launchOf({ acp_command: ['env', ...flavour, ...stubCommand.slice(1)], acp_thought_level: launched }),
    )
    const socket = open(id)
    await prompt(id, 'stub:effort')
    await socket.until(kindOf('turn_end'))
    expect(textOf(socket.events)).toStartWith(`[t1] Effort ${launched}. `)
    const switchEffort = (thoughtLevel: string) =>
      call('POST', `/api/conversations/${id}/switch_acp_model`, { thoughtLevel })
    expect((await switchEffort(switched)).status).toBe(200)
    expect((await switchEffort('extreme')).status).toBe(200)
    const effortOf = (event: AgentEvent | undefined) =>
      (event?.update.configOptions as { category?: string; currentValue: string }[] | undefined)?.find(
        (option) => option.category === 'thought_level',
      )?.currentValue
    expect(
      effortOf((await socket.until(kindOf('config_option_update'), 3)).findLast(kindOf('config_option_update'))),
    ).toBe(switched)
    await prompt(id, 'stub:effort')
    await socket.until(kindOf('turn_end'), 2)
    expect(textOf(socket.events.slice(-4))).toContain(`[t2] Effort ${switched}. `)
    expect(socket.events.filter(kindOf('session_started'))).toHaveLength(1)
  },
)

test('a Codex session selects full access among its listed modes', async () => {
  const { open, create, prompt } = started()
  const modes = 'STUB_MODES=read-only,workspace-write,agent,agent-full-access'
  const id = await create(launchOf({ acp_command: ['env', modes, ...stubCommand.slice(1)] }))
  const socket = open(id)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  expect(textOf(socket.events)).toBe('[t1] Hello from the stub (model stub-default, mode agent-full-access).')
})

test('a sub-conversation answers its own questions: a free assumption where the form has one, plan approvals approved', async () => {
  const { open, create, prompt } = started()
  const id = await create({ ...launchOf(), parent_conversation_id: crypto.randomUUID() })
  const socket = open(id)
  const assumption = 'No member is available; decide yourself and state your assumption.'
  await prompt(id, 'stub:ask')
  await socket.until(kindOf('turn_end'))
  expect(answerOf(socket.events)).toEqual({ action: 'accept', content: { question_0_custom: assumption } })
  expect(socket.events.find(kindOf('question_answered'))?.update).toMatchObject({
    kind: 'question',
    answers: {},
    free: { question_0: assumption },
  })

  await prompt(id, 'stub:ask-codex')
  await socket.until(kindOf('turn_end'), 2)
  expect(answerOf(socket.events.slice(-4)).content).toEqual({
    db: 'None of the above',
    db_note: assumption,
    lang: 'None of the above',
    lang_note: assumption,
    ci: 'None of the above',
    ci_note: assumption,
  })

  await prompt(id, 'stub:exit-plan')
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events.slice(-6))).toStartWith('plan:exit-plan-bypass ')
  expect(socket.events.filter(kindOf('question_answered')).at(-1)?.update).toMatchObject({
    kind: 'plan',
    approved: true,
  })
  expect(socket.events.filter(kindOf('question'))).toEqual([])
})

test('the question form shapes are keyed by the harness ids of the registry', () => {
  expect(Object.keys(formShapes)).toEqual(['claude-code', 'codex'])
})
