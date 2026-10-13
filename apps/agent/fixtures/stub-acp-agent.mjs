import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const configOptionsOf = ({ model, mode }) => [
  {
    id: 'mode',
    name: 'Mode',
    type: 'select',
    category: 'mode',
    currentValue: mode,
    options: modes.map((value) => ({ value, name: value })),
  },
  { id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model, options: models },
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
const turn = async (id, { sessionId, prompt }) => {
  const session = sessions.get(sessionId)
  session.prompts += 1
  const state = { cancelled: false }
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
  const session = { prompts, model: models[0].value, mode: 'default', current: undefined }
  sessions.set(sessionId, session)
  return { ...sessionResultOf(session), sessionId }
}
const handlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} } },
    agentInfo: { name: 'stub-acp-agent', version: '0.0.2' },
    authMethods: [],
  }),
  'session/new': () => {
    if (process.env.STUB_FAIL_START) throw { code: -32000, message: 'Authentication required' }
    return opened(randomUUID(), 0)
  },
  'session/resume': ({ sessionId }) => {
    if (!sessions.has(sessionId) && !existsSync(sessionFile(sessionId)))
      throw { code: -32002, message: 'Resource not found' }
    if (!sessions.has(sessionId)) opened(sessionId, JSON.parse(readFileSync(sessionFile(sessionId), 'utf8')).prompts)
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
