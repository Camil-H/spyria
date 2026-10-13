import { afterAll, afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
  const resent = open(id, lastSeq - 2)
  await resent.until(kindOf('turn_end'))
  expect(resent.events.map(({ seq }) => seq)).toEqual([lastSeq - 1, lastSeq])
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

  const missing = await create({ ...launchOf(), agent: { acp_command: ['hq-agent-no-such-adapter'] } })
  expect((await call('GET', `/api/conversations/${missing}`)).body).toMatchObject({ execution_status: 'error' })
  const failedStart = open(missing)
  await failedStart.until(kindOf('error'))
  expect(failedStart.events.map(({ update }) => update.sessionUpdate)).toEqual(['error'])
})

test('a subscription launch gets no gateway URL and no key, and hq-agent never logs environment values', async () => {
  const secretValues = ['inherited-anthropic-key-0001', 'http://gateway.invalid/v1', 'sk-hq-llm-token-0002', apiKey]
  const child = Bun.spawn(['bun', new URL('./main.ts', import.meta.url).pathname], {
    env: {
      PATH: String(process.env.PATH),
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

test('requests without the session key are refused, /ready is open', async () => {
  const { call } = started()
  expect((await call('GET', '/ready', undefined, '')).status).toBe(200)
  expect((await call('POST', '/api/conversations', launchOf(), 'wrong')).status).toBe(401)
  expect((await call('POST', '/api/conversations', { agent: { acp_command: 'node' } })).status).toBe(400)
})
