import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './agent.ts'

type AgentEvent = { id: string; seq: number; completed: boolean; update: Record<string, unknown> }

const apiKey = 'session-key-0123456789abcdef'
const stub = new URL('../fixtures/stub-acp-agent.mjs', import.meta.url).pathname
const stateDirectory = mkdtempSync(join(tmpdir(), 'hq-agent-test-'))
const stubCommand = ['env', `STUB_STATE=${stateDirectory}`, 'STUB_GAP_MS=5', 'node', stub]
const launchOf = (extra: Record<string, unknown> = {}, secrets = {}) => ({
  agent: { kind: 'ACPAgent', acp_command: stubCommand, ...extra },
  secrets,
  workspace: { kind: 'LocalWorkspace', working_dir: stateDirectory },
})
const running: { stop: () => void }[] = []
afterEach(() => {
  for (const agent of running.splice(0)) agent.stop()
})
afterAll(() => rmSync(stateDirectory, { recursive: true, force: true }))

const clientOf = (port: number) => {
  const call = async (method: string, path: string, body?: object, key = apiKey) => {
    const response = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-session-api-key': key },
      body: body && JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const open = (conversationId: string, after?: number, key = apiKey) => {
    const events: AgentEvent[] = []
    const socket = new WebSocket(
      `ws://localhost:${port}/sockets/events/${conversationId}${after === undefined ? '' : `?after=${after}`}`,
    )
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', session_api_key: key })))
    socket.addEventListener('message', (message) => events.push(JSON.parse(String(message.data))))
    const until = async (isDone: (event: AgentEvent) => boolean, count = 1) => {
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(5))
        if (events.filter(isDone).length >= count) return events
      throw new Error(`Timed out; events: ${JSON.stringify(events.map(({ update }) => update.sessionUpdate))}`)
    }
    return { events, until, closed, close: () => socket.close() }
  }
  const create = async (launch: object) => {
    const { status, body } = await call('POST', '/api/conversations', launch)
    expect(status).toBe(201)
    return String(body.id)
  }
  const prompt = (conversationId: string, text: string) =>
    call('POST', `/api/conversations/${conversationId}/events`, {
      role: 'user',
      content: [{ type: 'text', text }],
      run: true,
    })
  return { call, open, create, prompt }
}

const started = (bufferSize?: number) => {
  const agent = startAgent({ apiKey, port: 0, bufferSize })
  running.push(agent)
  return { agent, ...clientOf(agent.port) }
}
const kindOf = (kind: string) => (event: AgentEvent) => event.update.sessionUpdate === kind
const textOf = (events: AgentEvent[]) =>
  events
    .filter(kindOf('agent_message_chunk'))
    .map(({ update }) => (update.content as { text: string }).text)
    .join('')

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
  const { open, create, prompt } = started(4)
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

  const missing = await create({ ...launchOf(), agent: { acp_command: ['hq-agent-no-such-adapter'] } })
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
  const workingDirectory = mkdtempSync(join(tmpdir(), 'hq-agent-workspace-'))
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

test('a subscription launch gets no gateway URL and no key, hq-agent never logs environment values, and its own children never see its session key', async () => {
  const secretValues = ['inherited-anthropic-key-0001', 'http://gateway.invalid/v1', 'sk-hq-llm-token-0002', apiKey]
  const fakeGitDirectory = mkdtempSync(join(tmpdir(), 'hq-agent-git-'))
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
  while (!/port (\d+)/.test(output)) {
    const { value, done } = await reader.read()
    if (done) throw new Error(`hq-agent did not start: ${output}`)
    output += new TextDecoder().decode(value)
  }
  const { open, create, prompt } = clientOf(Number(/port (\d+)/.exec(output)?.[1]))
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
        { ANTHROPIC_API_KEY: { kind: 'StaticSecret', value: 'sk-hq-llm-token-0002' } },
      ),
    )
    expect(apiKeyLaunch).toEqual(expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']))
    await create({
      ...launchOf({ acp_command: ['hq-agent-no-such-adapter'] }),
      secrets: { X: { value: 'sk-hq-llm-token-0002' } },
    })
  } finally {
    child.kill()
  }
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    output += new TextDecoder().decode(chunk.value)
  const logs = output + (await new Response(child.stderr).text())
  expect(logs).toContain('hq-agent listening')
  for (const value of secretValues) expect(logs).not.toContain(value)
  const gitEnvironment = readFileSync(gitEnvironmentPath, 'utf8')
  rmSync(fakeGitDirectory, { recursive: true, force: true })
  expect(gitEnvironment).toContain('PATH=')
  expect(gitEnvironment).not.toContain('OH_SESSION_API_KEYS_0')
  expect(gitEnvironment).not.toContain(apiKey)
})

test('a new hq-agent resumes the session of an earlier one, and a missing session falls back to a new one', async () => {
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

const piLaunchOf = (extra: Record<string, unknown> = {}) =>
  launchOf({ acp_command: ['env', 'STUB_FLAVOUR=pi', ...stubCommand.slice(1)], adapter: 'pi-rpc', ...extra })
const piHello = (turn: number, mode = 'default') =>
  `[t${turn}] Hello from the stub (model stub/stub-default, mode ${mode}).`

test('a Pi turn over RPC streams thought and text, a command with its output and exit code and an edit diff, and ends the turn', async () => {
  const { open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  expect(socket.events).toEqual([])
  await prompt(id, 'stub:think stub:tools stub:terminal')
  await socket.until(kindOf('turn_end'))
  const [start] = socket.events
  expect(start?.update).toMatchObject({ sessionUpdate: 'session_started', resumeFailed: false })
  expect(String(start?.update.sessionId)).toEndWith('.json')
  expect(socket.events.filter(kindOf('agent_thought_chunk')).map(({ update }) => update.content)).toEqual([
    { type: 'text', text: 'Thinking ' },
    { type: 'text', text: 'about the plan.' },
  ])
  const finals = socket.events.filter((event) => kindOf('tool_call_update')(event) && event.completed)
  expect(finals.map(({ update }) => update)).toMatchObject([
    {
      toolCallId: 'edit-1',
      title: 'edit',
      kind: 'edit',
      status: 'completed',
      rawInput: { path: '/workspace/project/app.ts', edits: [{ oldText: 'one', newText: 'two' }] },
      content: [{ type: 'diff', path: '/workspace/project/app.ts', oldText: 'one', newText: 'two' }],
    },
    {
      toolCallId: 'command-1',
      title: 'npm test',
      kind: 'execute',
      status: 'failed',
      rawOutput: { formatted_output: 'exit code 1', exit_code: 1 },
    },
    {
      toolCallId: 'terminal-1',
      title: 'npm test',
      kind: 'execute',
      status: 'failed',
      rawOutput: { formatted_output: 'one\ntwo\nfailed', exit_code: 2 },
    },
  ])
  expect(textOf(socket.events)).toBe(`[t1] permission:allow-always ${piHello(1).slice(5)}`)
  expect(socket.events.at(-1)?.update).toEqual({ sessionUpdate: 'turn_end', stopReason: 'end_turn' })
})

test('a Pi update_plan call is an ACP plan, not a step; a provider error ends the turn with an error update', async () => {
  const { open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:plan')
  await socket.until(kindOf('turn_end'))
  expect(socket.events.filter(kindOf('plan')).map(({ update, completed }) => ({ update, completed }))).toEqual([
    {
      update: {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Write tests', status: 'completed', priority: 'medium' },
          { content: 'Fix the bug', status: 'in_progress', priority: 'medium' },
          { content: 'Ship', status: 'pending', priority: 'medium' },
        ],
      },
      completed: true,
    },
  ])
  expect(socket.events.filter((event) => String(event.update.sessionUpdate).startsWith('tool_call'))).toEqual([])

  await prompt(id, 'stub:provider-error')
  await socket.until(kindOf('turn_end'), 2)
  expect(socket.events.slice(-2).map(({ update }) => update)).toEqual([
    { sessionUpdate: 'error', message: '529 overloaded' },
    { sessionUpdate: 'turn_end', stopReason: 'end_turn' },
  ])
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 3)
  expect(socket.events.filter(kindOf('error'))).toHaveLength(1)
})

test('Stop aborts a Pi turn as cancelled and the next prompt continues the session', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:long')
  await socket.until((event) => event.update.toolCallId === 'long-1')
  expect((await call('POST', `/api/conversations/${id}/interrupt`, {})).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(socket.events.findLast(kindOf('turn_end'))?.update).toEqual({
    sessionUpdate: 'turn_end',
    stopReason: 'cancelled',
  })
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events)).toBe(`[t1] ${piHello(2)}`)
  expect(socket.events.findLast(kindOf('turn_end'))?.update.stopReason).toBe('end_turn')
})

test('a new hq-agent reopens a Pi session from its file with no replay, and a missing file falls back to a new session', async () => {
  const first = started()
  const id = await first.create(piLaunchOf())
  const socket = first.open(id)
  await first.prompt(id, 'hello')
  await socket.until(kindOf('turn_end'))
  const sessionId = String(socket.events.find(kindOf('session_started'))?.update.sessionId)
  first.agent.stop()

  const second = started()
  const reopenedId = await second.create(piLaunchOf({ acp_resume_session_id: sessionId }))
  expect((await second.call('GET', `/api/conversations/${reopenedId}`)).body).toMatchObject({
    acp_session_id: sessionId,
    execution_status: 'idle',
  })
  const reopened = second.open(reopenedId)
  await second.prompt(reopenedId, 'hello again')
  await reopened.until(kindOf('turn_end'))
  expect(reopened.events[0]?.update).toMatchObject({ sessionUpdate: 'session_started', sessionId, resumeFailed: false })
  expect(reopened.events.filter(kindOf('agent_message_chunk')).length).toBeGreaterThan(0)
  expect(textOf(reopened.events)).toBe(piHello(2))

  const fallbackId = await second.create(piLaunchOf({ acp_resume_session_id: `${stateDirectory}/missing.json` }))
  const fallback = second.open(fallbackId)
  await second.prompt(fallbackId, 'hello')
  await fallback.until(kindOf('turn_end'))
  expect(fallback.events[0]?.update).toMatchObject({ sessionUpdate: 'session_started', resumeFailed: true })
  expect(fallback.events[0]?.update.sessionId).not.toBe(sessionId)
  expect(textOf(fallback.events)).toBe(piHello(1))
})

test('a Pi model switch sets the thinking level after Pi resets it, at launch and in place', async () => {
  const { call, open, create } = started()
  const valuesOf = (update: Record<string, unknown> | undefined) =>
    ['model', 'thought_level'].map(
      (optionId) =>
        ((update?.configOptions ?? []) as { id: string; currentValue: string }[]).find(({ id }) => id === optionId)
          ?.currentValue,
    )
  const id = await create(piLaunchOf({ acp_model: 'stub/stub-large', acp_thought_level: 'high' }))
  const socket = open(id)
  await socket.until(kindOf('config_option_update'))
  const [start] = socket.events
  expect(valuesOf(start?.update)).toEqual(['stub/stub-default', 'medium'])
  expect(start?.update.configOptions).toMatchObject([
    {
      category: 'model',
      options: [
        { value: 'stub/stub-default', name: 'Default (stub)' },
        { value: 'stub/stub-large', name: 'Large (stub)' },
      ],
    },
    { category: 'thought_level', options: ['off', 'low', 'medium', 'high'].map((value) => ({ value, name: value })) },
  ])
  expect(valuesOf(socket.events.findLast(kindOf('config_option_update'))?.update)).toEqual(['stub/stub-large', 'high'])

  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'stub/stub-default', thoughtLevel: 'low' })
  await socket.until(kindOf('config_option_update'), 2)
  expect(valuesOf(socket.events.findLast(kindOf('config_option_update'))?.update)).toEqual(['stub/stub-default', 'low'])

  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'stub/stub-large', thoughtLevel: 'ultra' })
  await call('POST', `/api/conversations/${id}/switch_acp_model`, { model: 'hq/fake/fake-small' })
  await socket.until(kindOf('config_option_update'), 4)
  const unlisted = socket.events.filter(kindOf('config_option_update')).slice(-2)
  expect(unlisted.map(({ update }) => valuesOf(update))).toEqual([
    ['stub/stub-large', 'off'],
    ['hq/fake/fake-small', 'off'],
  ])
})

test("a Pi question from the extension's select is one free question: a pick, and Other with a free answer through Pi's input", async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
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
        id: 'answer',
        text: 'Which database should we use?',
        options: [
          { value: 'Postgres', label: 'Postgres' },
          { value: 'SQLite', label: 'SQLite' },
        ],
        multi: false,
        free: true,
      },
    ],
  }
  expect(socket.events.find(kindOf('question'))?.update).toEqual({ sessionUpdate: 'question', ...question })
  expect((await answerTo(questionId, { approve: true })).status).toBe(400)
  expect((await answerTo(questionId, { answers: { answer: 'SQLite' } })).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(textOf(socket.events)).toBe(`[t1] answer:The member answered: SQLite ${piHello(1).slice(5)}`)
  expect(socket.events.find(kindOf('question_answered'))?.update).toEqual({
    sessionUpdate: 'question_answered',
    ...question,
    answers: { answer: 'SQLite' },
  })

  await prompt(id, 'stub:ask')
  expect((await answerTo(await questionAt(socket, 2), { answers: {}, free: { answer: 'MySQL' } })).status).toBe(200)
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events.slice(-6))).toContain('answer:The member answered: MySQL ')
  expect(socket.events.filter(kindOf('question'))).toHaveLength(2)

  await prompt(id, 'stub:ask')
  await answerTo(await questionAt(socket, 3), { answers: {} })
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events.slice(-6))).toContain('answer:The member did not answer. ')
})

test("a Pi plan from the extension's confirm: keep planning and approve, the mode following the extension; the plan route switches it", async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  const modesOf = () => socket.events.filter(kindOf('current_mode_update')).map(({ update }) => update.currentModeId)
  const decide = async (approve: boolean, turns: number) => {
    const asked = socket.events.filter(kindOf('question')).length + 1
    await prompt(id, 'stub:exit-plan')
    const questionId = await questionAt(socket, asked)
    expect((await call('POST', `/api/conversations/${id}/questions/${questionId}`, { approve })).status).toBe(200)
    await socket.until(kindOf('turn_end'), turns)
    return socket.events.slice(socket.events.findLastIndex(kindOf('question')))
  }

  const kept = await decide(false, 1)
  expect(kept[0]?.update).toMatchObject({ kind: 'plan', toolCallId: 'exit-plan-1', plan: '1. Create x.txt\n2. Done' })
  expect(kept.find(kindOf('question_answered'))?.update).toMatchObject({ kind: 'plan', approved: false })
  expect(textOf(kept)).toBe(`plan:The member wants to keep planning. ${piHello(1, 'plan').slice(5)}`)
  expect(kept.find(kindOf('turn_end'))?.update).toEqual({ sessionUpdate: 'turn_end', stopReason: 'end_turn' })
  expect(modesOf()).toEqual(['plan'])

  const approved = await decide(true, 2)
  expect(textOf(approved)).toBe(
    `plan:The member approved the plan. Plan mode is off: carry it out. ${piHello(2).slice(5)}`,
  )
  expect(modesOf()).toEqual(['plan', 'default'])

  expect((await call('POST', `/api/conversations/${id}/plan_mode`, { enabled: true })).status).toBe(200)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 3)
  expect(textOf(socket.events.slice(-4))).toContain(piHello(3, 'plan'))
  expect((await call('POST', `/api/conversations/${id}/plan_mode`, { enabled: false })).status).toBe(200)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 4)
  expect(textOf(socket.events.slice(-4))).toContain(piHello(4))
  expect(modesOf()).toEqual(['plan', 'default', 'plan', 'default'])
  expect(socket.events.filter(kindOf('current_mode_update')).every((event) => event.completed)).toBe(true)
})

test('Stop while a Pi question waits closes it as stopped and cancels the dialog; a sub-conversation answers Pi questions itself', async () => {
  const { call, open, create, prompt } = started()
  const id = await create(piLaunchOf())
  const socket = open(id)
  await prompt(id, 'stub:ask')
  const questionId = await questionAt(socket, 1)
  expect((await call('POST', `/api/conversations/${id}/interrupt`, {})).status).toBe(200)
  await socket.until(kindOf('turn_end'))
  expect(socket.events.find(kindOf('question_closed'))?.update).toMatchObject({ questionId, reason: 'stopped' })
  expect(socket.events.findLast(kindOf('turn_end'))?.update).toEqual({
    sessionUpdate: 'turn_end',
    stopReason: 'cancelled',
  })
  expect(
    (await call('POST', `/api/conversations/${id}/questions/${questionId}`, { answers: { answer: 'SQLite' } })).status,
  ).toBe(409)
  await prompt(id, 'hello')
  await socket.until(kindOf('turn_end'), 2)
  expect(textOf(socket.events.slice(-4))).toContain(piHello(2))

  const assumption = 'No member is available; decide yourself and state your assumption.'
  const sub = await create({ ...piLaunchOf(), parent_conversation_id: crypto.randomUUID() })
  const subSocket = open(sub)
  await prompt(sub, 'stub:ask')
  await subSocket.until(kindOf('turn_end'))
  await prompt(sub, 'stub:exit-plan')
  await subSocket.until(kindOf('turn_end'), 2)
  expect(textOf(subSocket.events)).toContain(`answer:The member answered: ${assumption} `)
  expect(textOf(subSocket.events)).toContain('plan:The member approved the plan.')
  expect(subSocket.events.filter(kindOf('question_answered')).map(({ update }) => update)).toMatchObject([
    { kind: 'question', answers: {}, free: { answer: assumption } },
    { kind: 'plan', approved: true },
  ])
  expect(subSocket.events.filter(kindOf('question'))).toEqual([])
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
const questionAt = async (socket: ReturnType<ReturnType<typeof clientOf>['open']>, count: number) =>
  String((await socket.until(kindOf('question'), count)).filter(kindOf('question'))[count - 1]?.update.questionId)

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
