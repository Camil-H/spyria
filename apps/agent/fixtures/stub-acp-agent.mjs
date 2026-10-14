import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const stateDirectory = process.env.STUB_STATE ?? '/tmp/stub-acp-state'
const gapMilliseconds = Number(process.env.STUB_GAP_MS ?? 20)
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const models =
  process.env.STUB_FLAVOUR === 'codex'
    ? [
        { value: 'gpt-stub', name: 'GPT stub' },
        { value: 'gpt-stub-mini', name: 'GPT stub mini' },
      ]
    : [
        { value: 'stub-default', name: 'Default (stub)' },
        { value: 'stub-large', name: 'Large (stub)' },
      ]
const isPi = process.env.STUB_FLAVOUR === 'pi'
const thoughtLevels = ['off', 'low', 'medium', 'high']
const modes = ['default', 'plan', 'bypassPermissions']
const sessions = new Map()
const answers = new Map()
const queues = new Map()
let nextRequestId = 0

const sessionFile = (sessionId) => `${stateDirectory}/${sessionId}.json`
const save = (sessionId, session) => {
  mkdirSync(stateDirectory, { recursive: true })
  writeFileSync(sessionFile(sessionId), JSON.stringify({ prompts: session.prompts }))
}
const configOptionsOf = ({ model, mode, thought_level }) => [
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue: mode,
    options: modes.map((value) => ({ value, name: value })),
  },
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: models },
  ...(isPi
    ? [
        {
          id: 'thought_level',
          name: 'Thinking',
          type: 'select',
          category: 'thought_level',
          currentValue: thought_level,
          options: thoughtLevels.map((value) => ({ value, name: value })),
        },
      ]
    : []),
]
const sessionResultOf = (session) => ({
  configOptions: configOptionsOf(session),
  modes: { currentModeId: session.mode, availableModes: modes.map((id) => ({ id, name: id })) },
})
const ask = (method, params) => {
  const id = `stub-${nextRequestId++}`
  const answer = Promise.withResolvers()
  answers.set(id, answer.resolve)
  send({ id, method, params })
  return answer.promise
}

class Cancelled extends Error {}
const gatewayUrl = process.env.STUB_GATEWAY
const piConfigOf = (name) => JSON.parse(process.env[name] || '{}')
const mcpServers = piConfigOf('HQ_PI_MCP').mcpServers ?? {}
const piTools = ['bash', 'read', 'edit', 'write']
const withEnvironment = (value) => String(value).replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '')
const gatewayCall = (url, authorization, body, signal) =>
  fetch(`${gatewayUrl}${new URL(url).pathname}`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
    signal,
  })
const mcpCall = async (server, method, params = {}, signal = undefined) => {
  const { url, headers } = mcpServers[server]
  const rpc = { jsonrpc: '2.0', method, params, ...(!method.startsWith('notifications/') && { id: 1 }) }
  const response = await gatewayCall(url, withEnvironment(headers.Authorization), rpc, signal)
  return response.status === 200 ? JSON.parse((await response.text()) || '{}').result : undefined
}
const mcpToolsOf = async () => {
  const tools = {}
  for (const server of Object.keys(mcpServers)) {
    await mcpCall(server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
    await mcpCall(server, 'notifications/initialized')
    for (const { name } of (await mcpCall(server, 'tools/list'))?.tools ?? [])
      tools[`mcp__${server}__${name}`] = { server, name }
  }
  return tools
}
const completionOf = async (session, signal, update) => {
  const [provider = ''] = session.model.split('/')
  const { baseUrl, apiKey } = piConfigOf('HQ_PI_MODELS').providers[provider]
  const response = await gatewayCall(
    `${baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`,
    `Bearer ${withEnvironment(apiKey)}`,
    {
      model: session.model.slice(provider.length + 1),
      messages: session.history,
      tools: [...piTools, ...Object.keys(session.tools)].map((name) => ({ type: 'function', function: { name } })),
      stream: true,
    },
    signal,
  )
  const completion = { status: response.status, text: '', toolCall: undefined }
  if (response.status !== 200) return { ...completion, body: await response.text() }
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of response.body) {
    const lines = (buffered + decoder.decode(chunk, { stream: true })).split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines.filter((candidate) => candidate.startsWith('data: {'))) {
      const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {}
      if (delta.reasoning_content)
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta.reasoning_content } })
      if (delta.content)
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta.content } })
      completion.text += delta.content ?? ''
      const part = delta.tool_calls?.[0]
      if (part)
        completion.toolCall = {
          id: completion.toolCall?.id ?? part.id,
          type: 'function',
          function: {
            name: completion.toolCall?.function.name ?? part.function?.name,
            arguments: `${completion.toolCall?.function.arguments ?? ''}${part.function?.arguments ?? ''}`,
          },
        }
    }
  }
  return completion
}
const runCommand = (toolCallId, command, state, update) =>
  new Promise((done) => {
    const terminal = { terminal_id: toolCallId }
    const progress = { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' }
    update({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: command,
      kind: 'execute',
      status: 'pending',
      content: [{ type: 'terminal', terminalId: toolCallId }],
      _meta: { terminal_info: { ...terminal, cwd: process.cwd() } },
    })
    update(progress)
    const child = spawn('bash', ['-c', `${command} 2>&1`], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
      update({ ...progress, _meta: { terminal_output: { ...terminal, data: String(data) } } })
    })
    const abort = () => {
      if (child.exitCode === null) process.kill(-child.pid, 'SIGKILL')
    }
    state.abort.signal.addEventListener('abort', abort)
    child.on('close', (code) => {
      state.abort.signal.removeEventListener('abort', abort)
      const exitCode = state.cancelled ? 1 : (code ?? 1)
      update({
        ...progress,
        status: exitCode === 0 ? 'completed' : 'failed',
        _meta: {
          ...(state.cancelled && { terminal_output: { ...terminal, data: '\n\nCommand aborted' } }),
          terminal_exit: { ...terminal, exit_code: exitCode, signal: null },
        },
      })
      done(output.replace(/\n$/, ''))
    })
  })
const editFile = (toolCallId, { command, path, file_text, old_str, new_str, content }, update) => {
  const absolute = resolve(process.cwd(), String(path).replace('/workspace/project/', ''))
  const oldText = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
  const tool = command === 'view' ? 'read' : command === 'create' || content !== undefined ? 'write' : 'edit'
  const rawInput =
    tool === 'edit' ? { path, oldText: old_str, newText: new_str } : { path, content: file_text ?? content }
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: tool,
    kind: tool === 'read' ? 'read' : 'edit',
    status: 'in_progress',
    locations: [{ path }],
    rawInput: tool === 'read' ? { path } : rawInput,
  })
  if (tool === 'read') {
    const text = oldText ?? `File not found: ${path}`
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: oldText === null ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
    })
    return text
  }
  const newText =
    tool === 'edit' ? String(oldText ?? '').replace(String(old_str), String(new_str)) : String(rawInput.content)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, newText)
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'diff', path, oldText, newText }],
  })
  return `The file ${path} has been edited.`
}
const callMcpTool = async (toolCallId, name, rawInput, session, state, update) => {
  update({ sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput })
  const tool = session.tools[name]
  const result = tool
    ? await mcpCall(tool.server, 'tools/call', { name: tool.name, arguments: rawInput }, state.abort.signal)
    : undefined
  const text = (result?.content ?? [{ text: `Tool ${name} not found` }]).map((part) => part.text ?? '').join('')
  const status = result && !result.isError ? 'completed' : 'failed'
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status,
    content: [{ type: 'content', content: { type: 'text', text } }],
    rawOutput: result,
  })
  return text
}
const planStatuses = { done: 'completed', in_progress: 'in_progress' }
const runTool = async ({ id, function: { name, arguments: json } }, session, state, update) => {
  const input = JSON.parse(json || '{}')
  if (['terminal', 'bash', 'Bash'].includes(name)) return runCommand(id, String(input.command), state, update)
  if (['file_editor', 'Write'].includes(name))
    return editFile(id, { ...input, path: input.path ?? input.file_path }, update)
  if (name === 'think') return 'Your thought has been logged.'
  if (name !== 'task_tracker') return callMcpTool(id, name, input, session, state, update)
  const entries = input.task_list.map(({ title, status }) => ({
    content: title,
    status: planStatuses[status] ?? 'pending',
    priority: 'medium',
  }))
  update({ sessionUpdate: 'plan', entries })
  return 'Task list updated.'
}
const gatewayTurn = async (session, text, state, update) => {
  session.tools ??= await mcpToolsOf()
  session.history.push({ role: 'user', content: text })
  for (;;) {
    const { status, text: answer, toolCall } = await completionOf(session, state.abort.signal, update)
    if (status !== 200) return
    session.history.push({ role: 'assistant', content: answer, ...(toolCall && { tool_calls: [toolCall] }) })
    if (!toolCall) return
    const output = await runTool(toolCall, session, state, update)
    if (state.cancelled) throw new Cancelled()
    session.history.push({ role: 'tool', tool_call_id: toolCall.id, content: output })
  }
}
const turn = async (id, { sessionId, prompt }) => {
  const session = sessions.get(sessionId)
  session.prompts += 1
  const state = { cancelled: false, abort: new AbortController() }
  session.current = state
  save(sessionId, session)
  const text = prompt.map((block) => block.text ?? '').join('\n')
  const has = (part) => text.includes(`stub:${part}`)
  const update = (body) => send({ method: 'session/update', params: { sessionId, update: body } })
  const step = async () => {
    await sleep(gapMilliseconds)
    if (state.cancelled) throw new Cancelled()
  }
  const say = async (chunk) => {
    await step()
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } })
  }
  try {
    if (gatewayUrl && isPi && !text.includes('stub:')) {
      await gatewayTurn(session, text, state, update).catch((error) => {
        throw state.cancelled ? new Cancelled() : error
      })
      return send({ id, result: { stopReason: 'end_turn' } })
    }
    if (has('crash')) process.exit(3)
    if (has('fail')) return send({ id, error: { code: -32000, message: 'Authentication required' } })
    if (has('think')) {
      for (const chunk of ['Thinking ', 'about the plan.']) {
        await step()
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk } })
      }
    }
    if (has('slow')) await sleep(1500)
    await say(`[t${session.prompts}] `)
    if (has('env')) await say(`env:${JSON.stringify(Object.keys(process.env).sort())} `)
    if (has('tools')) {
      const edit = `edit-${session.prompts}`
      update({
        sessionUpdate: 'tool_call',
        toolCallId: edit,
        title: 'Edit',
        kind: 'edit',
        status: 'pending',
        rawInput: {},
      })
      await step()
      const rawInput = { file_path: '/workspace/project/app.ts', old_string: 'one', new_string: 'two' }
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: edit,
        title: 'Edit app.ts',
        rawInput,
        locations: [{ path: rawInput.file_path }],
      })
      const permission = await ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: edit, title: 'Edit app.ts' },
        options: [
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
        ],
      })
      await say(`permission:${permission.result?.outcome?.optionId} `)
      update({ sessionUpdate: 'tool_call_update', toolCallId: edit, status: 'in_progress' })
      await step()
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: edit,
        status: 'completed',
        content: [{ type: 'diff', path: rawInput.file_path, oldText: 'one', newText: 'two' }],
      })
      const command = `command-${session.prompts}`
      update({
        sessionUpdate: 'tool_call',
        toolCallId: command,
        title: 'Terminal',
        kind: 'execute',
        status: 'pending',
        rawInput: {},
      })
      await step()
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: command,
        title: 'npm test',
        rawInput: { command: 'npm test' },
      })
      await step()
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: command,
        status: 'failed',
        rawOutput: 'exit code 1',
        content: [{ type: 'content', content: { type: 'text', text: 'Tests failed' } }],
      })
    }
    if (has('plan')) {
      const entries = [
        { content: 'Write tests', status: 'completed', priority: 'high' },
        { content: 'Fix the bug', status: 'in_progress', priority: 'medium' },
        { content: 'Ship', status: 'pending', priority: 'low' },
      ]
      update({ sessionUpdate: 'plan', entries })
    }
    if (has('subagent')) {
      const task = `task-${session.prompts}`
      const child = `child-${session.prompts}`
      const taskCall = { toolCallId: task, title: 'Explore the repo', kind: 'think' }
      update({ sessionUpdate: 'tool_call', ...taskCall, title: 'Task', status: 'pending', rawInput: {} })
      await step()
      const rawInput = { description: 'Explore the repo', subagent_type: 'Explore' }
      update({ sessionUpdate: 'tool_call_update', ...taskCall, status: 'in_progress', rawInput })
      update({
        sessionUpdate: 'tool_call',
        toolCallId: child,
        title: 'ls',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      })
      await step()
      update({ sessionUpdate: 'tool_call_update', toolCallId: child, status: 'completed', rawOutput: 'a.ts' })
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: task,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'Two files.' } }],
      })
    }
    if (has('command')) {
      const command = `checked-${session.prompts}`
      const rawInput = { command: 'sleep 2 && echo checked' }
      update({
        sessionUpdate: 'tool_call',
        toolCallId: command,
        title: rawInput.command,
        kind: 'execute',
        status: 'in_progress',
        rawInput,
      })
      await step()
      if (has('linger')) await sleep(1500)
      await step()
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: command,
        status: 'completed',
        rawOutput: 'checked',
      })
    }
    if (has('read')) {
      const read = `read-${session.prompts}`
      update({
        sessionUpdate: 'tool_call',
        toolCallId: read,
        title: 'Read File',
        kind: 'read',
        status: 'pending',
        rawInput: {},
      })
      await step()
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: read,
        title: 'Read notes.md',
        rawInput: { file_path: '/workspace/project/notes.md' },
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'notes' } }],
      })
    }
    if (has('terminal')) {
      const terminal = `terminal-${session.prompts}`
      update({
        sessionUpdate: 'tool_call',
        toolCallId: terminal,
        title: 'npm test',
        kind: 'execute',
        status: 'pending',
        content: [{ type: 'terminal', terminalId: terminal }],
        _meta: { terminal_info: { terminal_id: terminal, cwd: '/workspace/project' } },
      })
      for (const data of ['one\n', 'two\n']) {
        await step()
        const terminal_output = { terminal_id: terminal, data }
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: terminal,
          status: 'in_progress',
          _meta: { terminal_output },
        })
      }
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: terminal,
        status: 'failed',
        _meta: {
          terminal_output: { terminal_id: terminal, data: 'failed' },
          terminal_exit: { terminal_id: terminal, exit_code: 2, signal: null },
        },
      })
    }
    if (has('long')) {
      const command = `long-${session.prompts}`
      update({
        sessionUpdate: 'tool_call',
        toolCallId: command,
        title: 'sleep 600',
        kind: 'execute',
        status: 'pending',
        rawInput: { command: 'sleep 600' },
      })
      update({ sessionUpdate: 'tool_call_update', toolCallId: command, status: 'in_progress' })
      for (;;) await step()
    }
    if (has('linger')) await sleep(1500)
    await say(`Hello from the stub (model ${session.model}, mode ${session.mode}).`)
    send({ id, result: { stopReason: 'end_turn' } })
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error
    if (has('late')) {
      await sleep(400)
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE ' } })
    }
    send({ id, result: { stopReason: 'cancelled' } })
  }
}

const opened = (sessionId, prompts) => {
  const session = {
    prompts,
    model: models[0].value,
    mode: 'default',
    thought_level: 'medium',
    current: undefined,
    history: [],
    tools: undefined,
  }
  sessions.set(sessionId, session)
  return { ...sessionResultOf(session), sessionId }
}
const savedPromptsOf = (sessionId) => {
  if (!sessions.has(sessionId) && !existsSync(sessionFile(sessionId)))
    throw { code: -32002, message: 'Resource not found' }
  return sessions.get(sessionId)?.prompts ?? JSON.parse(readFileSync(sessionFile(sessionId), 'utf8')).prompts
}
const replay = (sessionId, prompts) => {
  const update = (body) => send({ method: 'session/update', params: { sessionId, update: body } })
  for (let prompt = 1; prompt <= prompts; prompt += 1) {
    update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: `replayed prompt ${prompt}` } })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `replayed answer ${prompt}` } })
    const toolCallId = `replayed-${prompt}`
    update({ sessionUpdate: 'tool_call', toolCallId, title: 'ls', kind: 'execute', status: 'completed' })
    update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: 'replayed' })
  }
}
const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: isPi, sessionCapabilities: isPi ? {} : { resume: {} } },
    agentInfo: { name: 'stub-acp-agent', version: '0.0.2' },
    authMethods: [],
  }),
  'session/new': () => {
    if (process.env.STUB_FAIL_START) throw { code: -32000, message: 'Authentication required' }
    return opened(randomUUID(), 0)
  },
  'session/resume': ({ sessionId }) => {
    if (isPi) throw { code: -32601, message: 'Method not found: session/resume' }
    const prompts = savedPromptsOf(sessionId)
    if (!sessions.has(sessionId)) opened(sessionId, prompts)
    return sessionResultOf(sessions.get(sessionId))
  },
  'session/load': ({ sessionId }) => {
    const prompts = savedPromptsOf(sessionId)
    replay(sessionId, prompts)
    return opened(sessionId, prompts)
  },
  'session/set_mode': ({ sessionId, modeId }) => {
    sessions.get(sessionId).mode = modeId
    return {}
  },
  'session/set_config_option': ({ sessionId, configId, value }) => {
    const session = sessions.get(sessionId)
    session[configId] = value
    if (isPi && configId === 'model') session.thought_level = 'off'
    return { configOptions: configOptionsOf(session) }
  },
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    const frame = JSON.parse(line)
    if (frame.method === undefined) return answers.get(frame.id)?.(frame)
    if (frame.method === 'session/prompt') {
      const { sessionId } = frame.params
      queues.set(
        sessionId,
        (queues.get(sessionId) ?? Promise.resolve()).then(() => turn(frame.id, frame.params)),
      )
      return
    }
    if (frame.method === 'session/cancel') {
      const session = sessions.get(frame.params.sessionId)
      if (session?.current) session.current.cancelled = true
      session?.current?.abort.abort()
      return
    }
    if (frame.id === undefined) return
    const handler = handlers[frame.method]
    if (!handler) return send({ id: frame.id, error: { code: -32601, message: `stub: ${frame.method}` } })
    try {
      send({ id: frame.id, result: handler(frame.params ?? {}) })
    } catch (error) {
      send({ id: frame.id, error })
    }
  })
  .on('close', () => process.exit(0))
