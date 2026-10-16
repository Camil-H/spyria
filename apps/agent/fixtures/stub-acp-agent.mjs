import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'

const stateDirectory = process.env.STUB_STATE ?? '/tmp/stub-acp-state'
const gapMilliseconds = Number(process.env.STUB_GAP_MS ?? 20)
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const holdUrl = process.env.STUB_HOLD_URL
const lingerAs = (name) => (holdUrl ? fetch(`${holdUrl}&name=${name}`, { method: 'POST' }) : sleep(1500))
const send = (frame) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
const piSend = (record) => process.stdout.write(`${JSON.stringify(record)}\n`)
const isPi = process.env.STUB_FLAVOUR === 'pi'
const isSilentOn = (method) => {
  if (method !== process.env.STUB_SILENT) return false
  writeFileSync(`${stateDirectory}/silent.pid`, String(process.pid))
  return true
}
const models =
  process.env.STUB_FLAVOUR === 'codex'
    ? [
        { value: 'gpt-stub', name: 'GPT stub' },
        { value: 'gpt-stub-mini', name: 'GPT stub mini' },
      ]
    : [
        { value: `${isPi ? 'stub/' : ''}stub-default`, name: 'Default (stub)' },
        { value: `${isPi ? 'stub/' : ''}stub-large`, name: 'Large (stub)' },
      ]
const isCodex = process.env.STUB_FLAVOUR === 'codex'
const thoughtLevels = ['off', 'low', 'medium', 'high']
const modes = process.env.STUB_MODES?.split(',') ?? ['default', 'plan', 'bypassPermissions']
const sessions = new Map()
const answers = new Map()
const queues = new Map()
let nextRequestId = 0
let canElicit = false

const sessionFile = (sessionId) => `${stateDirectory}/${sessionId}.json`
const save = (sessionId, session) => {
  mkdirSync(stateDirectory, { recursive: true })
  writeFileSync(sessionFile(sessionId), JSON.stringify({ prompts: session.prompts, history: session.history }))
}
const configOptionsOf = ({ model, mode, collaboration_mode }) => [
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue: mode,
    options: modes.map((value) => ({ value, name: value })),
  },
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: models },
  ...(isCodex
    ? [
        {
          id: 'collaboration_mode',
          name: 'Collaboration mode',
          type: 'select',
          currentValue: collaboration_mode,
          options: ['default', 'plan'].map((value) => ({ value, name: value })),
        },
      ]
    : []),
]
const sessionResultOf = (session) => ({
  configOptions: configOptionsOf(session),
  modes: { currentModeId: session.mode, availableModes: modes.map((id) => ({ id, name: id })) },
})
const ask = (method, params) => {
  if (isPi)
    return Promise.resolve({ result: { outcome: { outcome: 'selected', optionId: params.options.at(-1).optionId } } })
  const id = `stub-${nextRequestId++}`
  const answer = Promise.withResolvers()
  answers.set(id, answer.resolve)
  send({ id, method, params })
  return answer.promise
}
const choicesOf = (labels) => labels.map(([label, description]) => ({ const: label, title: label, description }))
const codexQuestionOf = (id, text, header, labels) => ({
  [id]: {
    type: 'string',
    title: text,
    description: header,
    _meta: { codex: { isOther: true, isSecret: false } },
    oneOf: choicesOf([...labels, ['None of the above', 'Provide a different answer in the note field.']]),
  },
  [`${id}_note`]: { type: 'string', title: 'Additional answer or note' },
})
const claudeAskSchema = {
  type: 'object',
  properties: {
    question_0: {
      type: 'string',
      title: 'Database',
      oneOf: choicesOf([
        ['Postgres', 'Relational'],
        ['SQLite', 'Embedded'],
      ]),
    },
    question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer (optional).' },
  },
}
const codexAskSchema = {
  type: 'object',
  properties: {
    ...codexQuestionOf('db', 'Which database should I use?', 'Database', [
      ['Postgres', 'Relational'],
      ['SQLite', 'File'],
    ]),
    ...codexQuestionOf('lang', 'Which language?', 'Language', [['TypeScript'], ['Go']]),
    ...codexQuestionOf('ci', 'Which CI?', 'CI', [['GitHub Actions'], ['None']]),
  },
  required: ['db', 'lang', 'ci'],
}
const claudePlanOptions = [
  { optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
  { optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
  { optionId: 'exit-plan-clear-context', name: 'Yes, clear context and bypass permissions', kind: 'allow_always' },
  { optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
]
const codexPlanOptions = [
  { optionId: 'implement_plan', name: 'Yes, implement this plan', kind: 'allow_once' },
  { optionId: 'revise_plan', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
]

class Cancelled extends Error {}
const piToolCalls = new Map()
const piToolNameOf = ({ kind, title }) =>
  ({ execute: 'bash', read: 'read', edit: /^write/i.test(title) ? 'write' : 'edit' })[kind] ?? title
const piArgumentsOf = (toolName, { title, rawInput = {} }) =>
  toolName === 'bash'
    ? { command: rawInput.command ?? title }
    : toolName === 'edit' && !rawInput.edits
      ? {
          path: rawInput.path ?? rawInput.file_path,
          edits: [
            { oldText: rawInput.old_string ?? rawInput.oldText, newText: rawInput.new_string ?? rawInput.newText },
          ],
        }
      : rawInput
let piBlock
const piBlockEvent = (type, fields = {}) =>
  piSend({
    type: 'message_update',
    assistantMessageEvent: { type: `${piBlock.type}_${type}`, contentIndex: 0, ...fields },
  })
const closePiBlock = () => {
  if (!piBlock) return
  piBlockEvent('end', { content: piBlock.text })
  piSend({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: piBlock.type, [piBlock.type]: piBlock.text }], stopReason: 'stop' },
  })
  piBlock = undefined
}
const piUpdate = (update) => {
  const { sessionUpdate: kind, toolCallId } = update
  if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
    const type = kind === 'agent_message_chunk' ? 'text' : 'thinking'
    if (piBlock?.type !== type) {
      closePiBlock()
      piBlock = { type, text: '' }
      piBlockEvent('start')
    }
    piBlock.text += update.content.text
    return piBlockEvent('delta', { delta: update.content.text })
  }
  if (!String(kind).startsWith('tool_call')) return
  closePiBlock()
  const previous = piToolCalls.get(toolCallId)
  const call = {
    ...previous,
    ...update,
    output: `${previous?.output ?? ''}${update._meta?.terminal_output?.data ?? ''}`,
  }
  piToolCalls.set(toolCallId, call)
  const toolName = piToolNameOf(call)
  const isDone = ['completed', 'failed'].includes(call.status)
  if (!previous?.isStarted && (call.status === 'in_progress' || isDone)) {
    call.isStarted = true
    piSend({ type: 'tool_execution_start', toolCallId, toolName, args: piArgumentsOf(toolName, call) })
  }
  if (!isDone) return
  piToolCalls.delete(toolCallId)
  const exitCode = update._meta?.terminal_exit?.exit_code
  const text =
    call.output || (typeof call.rawOutput === 'string' ? call.rawOutput : (call.content?.[0]?.content?.text ?? ''))
  piSend({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: {
      content: [{ type: 'text', text }],
      details: {},
      ...(exitCode !== undefined && { structuredContent: { output: call.output, exit_code: exitCode } }),
    },
    isError: call.status === 'failed',
  })
}
const dialogs = new Map()
const piDialog = (method, fields) => {
  const id = randomUUID()
  const answer = Promise.withResolvers()
  dialogs.set(id, answer.resolve)
  piSend({ type: 'extension_ui_request', id, method, ...fields })
  return answer.promise
}
const setPiMode = (session, mode) => {
  session.mode = mode
  piSend({
    type: 'extension_ui_request',
    id: randomUUID(),
    method: 'setStatus',
    statusKey: 'hq-plan',
    statusText: mode,
  })
}
const otherChoice = 'Other…'
const piTool = async (toolCallId, name, rawInput, update, run) => {
  update({ sessionUpdate: 'tool_call', toolCallId, title: name, kind: 'other', status: 'in_progress', rawInput })
  const text = await run()
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text } }],
  })
  return text
}
const askMember = (toolCallId, { question, options }, update) =>
  piTool(toolCallId, 'ask_member', { question, options }, update, async () => {
    const { value: choice } = await piDialog('select', { title: question, options: [...options, otherChoice] })
    const answer = choice === otherChoice ? (await piDialog('input', { title: question })).value : choice
    return answer ? `The member answered: ${answer}` : 'The member did not answer.'
  })
const proposePlan = (toolCallId, { plan }, session, update) =>
  piTool(toolCallId, 'propose_plan', { plan }, update, async () => {
    if (!(await piDialog('confirm', { title: 'Approve the plan?', message: plan })).confirmed)
      return 'The member wants to keep planning.'
    setPiMode(session, 'default')
    return 'The member approved the plan. Plan mode is off: carry it out.'
  })
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
const piMcpTimeoutSeconds = 60
const mcpCall = async (server, method, params = {}, signal = undefined) => {
  const { url, headers, timeout = piMcpTimeoutSeconds } = mcpServers[server]
  const timedOut = AbortSignal.timeout(timeout * 1000)
  const rpc = { jsonrpc: '2.0', method, params, ...(!method.startsWith('notifications/') && { id: 1 }) }
  const response = await gatewayCall(
    url,
    withEnvironment(headers.Authorization),
    rpc,
    signal ? AbortSignal.any([signal, timedOut]) : timedOut,
  ).catch((error) => {
    if (signal?.aborted || !timedOut.aborted) throw error
  })
  if (!response) return { isError: true, content: [{ text: `MCP request timed out after ${timeout * 1000}ms` }] }
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
      tools: [...piTools, 'ask_member', 'propose_plan', 'update_plan', ...Object.keys(session.tools)].map((name) => ({
        type: 'function',
        function: { name },
      })),
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
const editFile = (toolCallId, tool, rawInput, update) => {
  const { path, content, edits = [] } = rawInput
  const absolute = resolve(process.cwd(), String(path).replace('/workspace/project/', ''))
  const oldText = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null
  update({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: tool,
    kind: tool === 'read' ? 'read' : 'edit',
    status: 'in_progress',
    locations: [{ path }],
    rawInput,
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
    tool === 'edit'
      ? edits.reduce((text, edit) => text.replace(String(edit.oldText), String(edit.newText)), String(oldText ?? ''))
      : String(content)
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
const runTool = async ({ id, function: { name, arguments: json } }, session, state, update) => {
  const input = JSON.parse(json || '{}')
  if (name === 'bash') return runCommand(id, String(input.command), state, update)
  if (['read', 'edit', 'write'].includes(name)) return editFile(id, name, input, update)
  if (name === 'think') return 'Your thought has been logged.'
  if (name === 'ask_member') return askMember(id, input, update)
  if (name === 'propose_plan') return proposePlan(id, input, session, update)
  if (name === 'update_plan') return piTool(id, name, input, update, async () => 'Plan updated.')
  return callMcpTool(id, name, input, session, state, update)
}
const gatewayTurn = async (session, text, state, update) => {
  session.tools ??= await mcpToolsOf()
  session.history.push({ role: 'user', content: text })
  for (;;) {
    const { status, text: answer, toolCall, body } = await completionOf(session, state.abort.signal, update)
    if (status !== 200)
      return piSend({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: `${status} ${body}` },
      })
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
  const has = (part) => new RegExp(`stub:${part}(?![\\w-])`).test(text)
  const update = isPi ? piUpdate : (body) => send({ method: 'session/update', params: { sessionId, update: body } })
  const finish = (stopReason) => {
    if (!isPi) return send({ id, result: { stopReason } })
    closePiBlock()
    piSend({ type: 'agent_settled', aborted: stopReason === 'cancelled' })
  }
  const refuse = (message) =>
    isPi
      ? piSend({ id, type: 'response', command: 'prompt', success: false, error: message })
      : send({ id, error: { code: -32000, message } })
  if (isPi && !has('fail'))
    piSend({ id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } })
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
      save(sessionId, session)
      return finish('end_turn')
    }
    if (has('crash')) process.exit(3)
    const branch = text.match(/stub:branch (\S+)/)?.[1]
    if (branch)
      for (const git of [
        ['init', '-q'],
        ['checkout', '-q', '-b', branch],
      ])
        spawnSync('git', ['-c', 'init.defaultBranch=main', ...git], { stdio: 'ignore' })
    if (has('fail')) return refuse('Authentication required')
    if (has('auth-expired')) {
      await say('OAuth session expired and could not be refreshed.')
      return refuse('Authentication required')
    }
    if (isPi && has('provider-error')) {
      piSend({
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: '529 overloaded' },
      })
      return finish('end_turn')
    }
    if (has('think')) {
      for (const chunk of ['Thinking ', 'about the plan.']) {
        await step()
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk } })
      }
    }
    if (has('slow')) await lingerAs('slow')
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
    if (isPi && has('ask')) {
      const question = { question: 'Which database should we use?', options: ['Postgres', 'SQLite'] }
      await say(`answer:${await askMember(`ask-${session.prompts}`, question, update)} `)
      await step()
    } else if (has('ask') || has('ask-codex')) {
      const isCodex = has('ask-codex')
      if (!canElicit) return refuse('stub: the client has no form elicitation')
      const request = ask('elicitation/create', {
        mode: 'form',
        sessionId,
        toolCallId: `ask-${session.prompts}`,
        message: isCodex ? 'Codex needs your input to continue.' : 'Which database should we use?',
        requestedSchema: isCodex ? codexAskSchema : claudeAskSchema,
      })
      if (has('withdraw')) send({ method: '$/cancel_request', params: { requestId: `stub-${nextRequestId - 1}` } })
      await say(`answer:${JSON.stringify((await request).result)} `)
    }
    if (isPi && has('exit-plan')) {
      if (session.mode !== 'plan') setPiMode(session, 'plan')
      await say(
        `plan:${await proposePlan(`exit-plan-${session.prompts}`, { plan: '1. Create x.txt\n2. Done' }, session, update)} `,
      )
      await step()
    } else if (has('exit-plan') || has('plan-codex')) {
      const isCodex = has('plan-codex')
      const toolCallId = `${isCodex ? 'plan-review' : 'exit-plan'}-${session.prompts}`
      const plan = '1. Create x.txt\n2. Done'
      if (!isCodex && session.mode !== 'plan') {
        session.mode = 'plan'
        update({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
      }
      const toolCall = { toolCallId, title: 'Approve Plan', kind: 'switch_mode', status: 'pending', rawInput: {} }
      if (!isCodex) {
        update({ sessionUpdate: 'tool_call', ...toolCall })
        update({ sessionUpdate: 'tool_call_update', toolCallId, rawInput: { plan } })
      }
      const permission = await ask('session/request_permission', {
        sessionId,
        toolCall: isCodex ? { ...toolCall, title: 'Implement this plan?', rawInput: { plan } } : toolCall,
        options: isCodex ? codexPlanOptions : claudePlanOptions,
      })
      const optionId = permission.result?.outcome?.optionId
      await say(`plan:${optionId ?? 'cancelled'} `)
      if (optionId === 'reject') return finish('cancelled')
      if (optionId?.startsWith('exit-plan')) {
        session.mode = optionId === 'exit-plan-default' ? 'default' : 'bypassPermissions'
        update({ sessionUpdate: 'current_mode_update', currentModeId: session.mode })
        update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
      }
    }
    if (has('write')) {
      const permission = await ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: `write-${session.prompts}`, title: 'Write x.txt', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
          { optionId: 'reject', name: 'No', kind: 'reject_once' },
        ],
      })
      await say(`write:${permission.result?.outcome?.optionId} `)
    }
    if (has('plan')) {
      const entries = [
        { content: 'Write tests', status: 'completed', priority: 'high' },
        { content: 'Fix the bug', status: 'in_progress', priority: 'medium' },
        { content: 'Ship', status: 'pending', priority: 'low' },
      ]
      if (isPi) await piTool(`plan-${session.prompts}`, 'update_plan', { entries }, update, async () => 'Plan updated.')
      else update({ sessionUpdate: 'plan', entries })
    }
    if (has('plan-progress'))
      for (const status of ['in_progress', 'completed']) {
        await step()
        update({
          sessionUpdate: 'plan',
          entries: [
            { content: 'Reproduce the bug', status: 'completed', priority: 'high' },
            { content: 'Fix the totals', status, priority: 'medium' },
          ],
        })
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
      if (has('linger')) await lingerAs('linger')
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
    if (has('linger')) await lingerAs('linger')
    await say(`Hello from the stub (model ${session.model}, mode ${session.mode}).`)
    finish('end_turn')
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error
    if (has('late')) {
      await sleep(400)
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE ' } })
    }
    finish('cancelled')
  }
}

const opened = (sessionId, { prompts, history }) => {
  const session = {
    prompts,
    model: models[0].value,
    mode: 'default',
    thought_level: 'medium',
    collaboration_mode: 'default',
    current: undefined,
    history,
    tools: undefined,
  }
  sessions.set(sessionId, session)
  return { ...sessionResultOf(session), sessionId }
}
const fresh = () => ({ prompts: 0, history: [] })
const savedOf = (path) => ({ ...fresh(), ...JSON.parse(readFileSync(path, 'utf8')) })
const handlers = {
  initialize: ({ clientCapabilities }) => {
    canElicit = Boolean(clientCapabilities?.elicitation?.form)
    return {
      protocolVersion: 1,
      agentCapabilities: { sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'stub-acp-agent', version: '0.0.2' },
      authMethods: [],
    }
  },
  'session/new': () => {
    if (process.env.STUB_FAIL_START) throw { code: -32000, message: 'Authentication required' }
    return opened(randomUUID(), fresh())
  },
  'session/resume': ({ sessionId }) => {
    if (!sessions.has(sessionId) && !existsSync(sessionFile(sessionId)))
      throw { code: -32002, message: 'Resource not found' }
    if (!sessions.has(sessionId)) opened(sessionId, savedOf(sessionFile(sessionId)))
    return sessionResultOf(sessions.get(sessionId))
  },
  'session/set_mode': ({ sessionId, modeId }) => {
    sessions.get(sessionId).mode = modeId
    return {}
  },
  'session/set_config_option': ({ sessionId, configId, value }) => {
    const session = sessions.get(sessionId)
    session[configId] = value
    return { configOptions: configOptionsOf(session) }
  },
}
const queue = (sessionId, run) => queues.set(sessionId, (queues.get(sessionId) ?? Promise.resolve()).then(run))
const cancel = (session) => {
  if (session?.current) session.current.cancelled = true
  session?.current?.abort.abort()
}
let piSessionId = randomUUID()
if (isPi) opened(piSessionId, fresh())
const piSession = () => sessions.get(piSessionId)
const piModelOf = (model) => {
  const [provider, ...id] = model.split('/')
  return { provider, id: id.join('/') }
}
const piCommands = {
  get_state: () => ({
    sessionFile: sessionFile(piSessionId),
    sessionId: piSessionId,
    model: piModelOf(piSession().model),
    thinkingLevel: piSession().thought_level,
  }),
  get_available_models: () => ({ models: models.map(({ value, name }) => ({ ...piModelOf(value), name })) }),
  get_available_thinking_levels: () => ({ levels: thoughtLevels }),
  set_model: ({ provider, modelId }) => {
    const { providers } = piConfigOf('HQ_PI_MODELS')
    if (providers && !providers[provider]?.models.some(({ id }) => id === modelId))
      throw new Error(`Model not found: ${provider}/${modelId}`)
    return Object.assign(piSession(), { model: `${provider}/${modelId}`, thought_level: 'off' }) && {}
  },
  set_thinking_level: ({ level }) => Object.assign(piSession(), { thought_level: level }) && {},
  switch_session: ({ sessionPath }) => {
    piSessionId = basename(sessionPath, '.json')
    opened(piSessionId, existsSync(sessionPath) ? savedOf(sessionPath) : fresh())
    return { cancelled: false }
  },
  abort: async () => {
    cancel(piSession())
    await queues.get(piSessionId)
    return {}
  },
}
const onPiCommand = async ({ id, type, ...fields }) => {
  if (type === 'extension_ui_response') return dialogs.get(id)?.(fields)
  if (isSilentOn(type)) return
  const respond = (data) => piSend({ id, type: 'response', command: type, success: true, data })
  if (type === 'prompt' && fields.message.startsWith('/hq-plan ')) {
    setPiMode(piSession(), fields.message.endsWith(' on') ? 'plan' : 'default')
    return respond({ disposition: 'handled' })
  }
  if (type === 'prompt')
    return queue(piSessionId, () => turn(id, { sessionId: piSessionId, prompt: [{ text: fields.message }] }))
  if (!piCommands[type]) return piSend({ id, type: 'response', command: type, success: false, error: `stub: ${type}` })
  try {
    respond(await piCommands[type](fields))
  } catch (error) {
    piSend({ id, type: 'response', command: type, success: false, error: error.message })
  }
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    const frame = JSON.parse(line)
    if (isPi) return void onPiCommand(frame)
    if (frame.method === undefined) return answers.get(frame.id)?.(frame)
    if (frame.method === 'session/prompt') return queue(frame.params.sessionId, () => turn(frame.id, frame.params))
    if (frame.method === 'session/cancel') return cancel(sessions.get(frame.params.sessionId))
    if (frame.id === undefined || isSilentOn(frame.method)) return
    const handler = handlers[frame.method]
    if (!handler) return send({ id: frame.id, error: { code: -32601, message: `stub: ${frame.method}` } })
    try {
      send({ id: frame.id, result: handler(frame.params ?? {}) })
    } catch (error) {
      send({ id: frame.id, error })
    }
  })
  .on('close', () => process.exit(0))
