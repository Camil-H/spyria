import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FakeAgentServer, FakeContainer, ModelCall } from '../testing.ts'

export type Event = { id: string; kind: string; timestamp: string; [field: string]: unknown }
export type Conversation = {
  id: string
  apiKey: string
  created: Record<string, unknown>
  events: Event[]
  executionStatus: string
  listeners: Set<(event: Event) => void>
  closers: Set<() => void>
  history: object[]
  turnAbort?: AbortController
  mcpServerOfTool?: Record<string, string>
  llmsByUsageId: Map<string, object>
}
type Turn = (conversation: Conversation, text: string) => Promise<void>

export const text = (value: string) => [{ type: 'text', text: value }]
const textOf = (observation: { content: { text: string }[] }) => observation.content.map((part) => part.text).join('')
export const replyText = 'Understood, working on it.'

type ToolCall = { id: string; function: { name: string; arguments: string } }
type Completion = { status: number | undefined; body: string; text: string; reasoning: string; toolCall?: ToolCall }

const workingDirectory = '/workspace/project/'
const modelTimeoutMilliseconds = 300_000
const toolNames = ['terminal', 'file_editor', 'task_tracker', 'think', 'finish']

const completionOf = async (
  modelCall: ModelCall,
  conversation: Conversation,
  onDelta: (delta: { content?: string; reasoning_content?: string }) => void,
  signal: AbortSignal,
): Promise<Completion> => {
  const { agent, secrets } = conversation.created as {
    agent: { llm?: { model: string; api_key: string } }
    secrets?: { ANTHROPIC_API_KEY?: { value: string } }
  }
  const llm = agent.llm ?? { model: 'anthropic/claude-opus-5-5', api_key: secrets?.ANTHROPIC_API_KEY?.value ?? '' }
  let buffered = ''
  const completion: Completion = { status: undefined, body: '', text: '', reasoning: '' }
  const response = await modelCall({
    headers: { authorization: `Bearer ${llm.api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: llm.model.replace(/^openai\//, ''),
      messages: conversation.history,
      tools: [...toolNames, ...Object.keys(conversation.mcpServerOfTool ?? {})].map((name) => ({
        type: 'function',
        function: { name },
      })),
      stream: true,
    }),
    signal,
    timeoutMilliseconds: modelTimeoutMilliseconds,
    onChunk: (data) => {
      const lines = (buffered + data).split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: {')) continue
        const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta ?? {}
        if (delta.content) completion.text += delta.content
        if (delta.reasoning_content) completion.reasoning += delta.reasoning_content
        if (delta.tool_calls?.[0]) completion.toolCall = delta.tool_calls[0]
        if (delta.content || delta.reasoning_content)
          onDelta(
            delta.content ? { content: delta.content } : { content: '', reasoning_content: delta.reasoning_content },
          )
      }
    },
  })
  return { ...completion, status: response.status, body: response.body }
}

const runCommand = async (command: string, cwd: string) => {
  const child = Bun.spawn(['bash', '-c', `${command} 2>&1`], { cwd, stdout: 'pipe' })
  const output = await new Response(child.stdout).text()
  return { output: output.replace(/\n$/, ''), exitCode: await child.exited }
}

const actionOf = (name: string, args: Record<string, unknown>) =>
  name === 'terminal'
    ? { kind: 'TerminalAction', command: args.command }
    : name === 'file_editor'
      ? { kind: 'FileEditorAction', ...args }
      : name === 'task_tracker'
        ? { kind: 'TaskTrackerAction', ...args }
        : { kind: 'ThinkAction', thought: args.thought }

const observe = async (name: string, args: Record<string, unknown>, directory: string) => {
  if (name === 'terminal') {
    const { output, exitCode } = await runCommand(String(args.command), directory)
    return { kind: 'TerminalObservation', content: text(output), exit_code: exitCode }
  }
  if (name === 'file_editor') {
    const path = join(directory, String(args.path).replace(workingDirectory, ''))
    let oldContent = ''
    try {
      oldContent = readFileSync(path, 'utf8')
    } catch {}
    const newContent =
      args.command === 'create'
        ? String(args.file_text)
        : oldContent.replace(String(args.old_str), String(args.new_str))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, newContent)
    return {
      kind: 'FileEditorObservation',
      command: args.command,
      path: args.path,
      old_content: oldContent,
      new_content: newContent,
      content: text(`The file ${args.path} has been edited.`),
    }
  }
  if (name === 'task_tracker') return { kind: 'TaskTrackerObservation', content: text('Task list updated.') }
  return { kind: 'ThinkObservation', content: text('Your thought has been logged.') }
}

export const createFakeAgentServer = ({ modelCall }: { modelCall?: () => ModelCall } = {}) => {
  const conversations = new Map<string, Conversation>()
  const prompts: { conversationId: string; text: string }[] = []
  const connections: { conversationId: string; query: string; auth: unknown }[] = []
  const interrupts: string[] = []
  let clock = 0
  const emit = (conversation: Conversation, kind: string, fields: Record<string, unknown> = {}, repeat = 1) => {
    const event = {
      id: crypto.randomUUID(),
      kind,
      timestamp: `2026-10-05T20:00:00.${String(++clock).padStart(6, '0')}`,
      ...fields,
    }
    if (kind !== 'StreamingDeltaEvent') conversation.events.push(event)
    for (let sent = 0; sent < repeat; sent++) for (const listener of conversation.listeners) listener(event)
    return event
  }
  const status = (conversation: Conversation, value: string) => {
    conversation.executionStatus = value
    return emit(conversation, 'ConversationStateUpdateEvent', { source: 'environment', key: 'execution_status', value })
  }
  const beginTurn = async (conversation: Conversation, prompt: string) => {
    emit(conversation, 'MessageEvent', { source: 'user', llm_message: { role: 'user', content: text(prompt) } })
    status(conversation, 'running')
    for (const word of replyText.split(/(?<= )/)) {
      await Bun.sleep(5)
      emit(conversation, 'StreamingDeltaEvent', { source: 'agent', content: word })
    }
  }
  const finishTurn = (conversation: Conversation, repeat = 1) => {
    emit(
      conversation,
      'MessageEvent',
      { source: 'agent', llm_message: { role: 'assistant', content: text(replyText) } },
      repeat,
    )
    status(conversation, 'finished')
  }
  const defaultTurn: Turn = async (conversation, prompt) => {
    await beginTurn(conversation, prompt)
    finishTurn(conversation)
  }
  const directoryByApiKey = new Map<string, string>()
  const directoryOf = (apiKey: string) => {
    const directory = directoryByApiKey.get(apiKey) ?? mkdtempSync(join(tmpdir(), 'hq-fake-agent-'))
    directoryByApiKey.set(apiKey, directory)
    return directory
  }
  const mcpConfigOf = (conversation: Conversation) =>
    (conversation.created.agent as { mcp_config?: Record<string, { url: string; headers: Record<string, string> }> })
      .mcp_config ?? {}
  const mcpCall = async (conversation: Conversation, server: string, method: string, params: object = {}) => {
    const mcp = mcpConfigOf(conversation)[server]
    const call = modelCall?.()
    if (!mcp || !call) return undefined
    const answer = await call({
      path: new URL(mcp.url).pathname,
      headers: {
        authorization: String(mcp.headers.Authorization),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(!method.startsWith('notifications/') && { id: 1 }) }),
    })
    return answer.status === 200 ? JSON.parse(answer.body || '{}').result : undefined
  }
  const startMcp = async (conversation: Conversation) => {
    const serverOfTool: Record<string, string> = {}
    for (const server of Object.keys(mcpConfigOf(conversation))) {
      await mcpCall(conversation, server, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })
      await mcpCall(conversation, server, 'notifications/initialized')
      const listed = await mcpCall(conversation, server, 'tools/list')
      for (const tool of (listed?.tools ?? []) as { name: string }[]) serverOfTool[tool.name] = server
    }
    return serverOfTool
  }
  const observeMcp = async (conversation: Conversation, name: string, args: Record<string, unknown>) => {
    const server = conversation.mcpServerOfTool?.[name] ?? ''
    const result = await mcpCall(conversation, server, 'tools/call', { name, arguments: args })
    return {
      kind: 'MCPToolObservation',
      tool_name: name,
      is_error: result?.isError ?? true,
      content: [...text(`[Tool '${name}' executed.]`), ...(result?.content ?? text('MCP client not connected'))],
    }
  }
  const scriptedTurn: Turn = async (conversation, prompt) => {
    conversation.mcpServerOfTool ??= await startMcp(conversation)
    const abort = new AbortController()
    conversation.turnAbort?.abort()
    conversation.turnAbort = abort
    const { signal } = abort
    const emitLive = (kind: string, fields: Record<string, unknown> = {}) =>
      signal.aborted ? undefined : emit(conversation, kind, fields)
    emitLive('MessageEvent', { source: 'user', llm_message: { role: 'user', content: text(prompt) } })
    conversation.history.push({ role: 'user', content: prompt })
    if (!signal.aborted) status(conversation, 'running')
    while (!signal.aborted) {
      const completion = await completionOf(
        modelCall?.() as ModelCall,
        conversation,
        (delta) => emitLive('StreamingDeltaEvent', { source: 'agent', ...delta }),
        signal,
      )
      if (signal.aborted) return
      if (completion.status !== 200) {
        status(conversation, 'error')
        emit(conversation, 'ConversationErrorEvent', {
          source: 'environment',
          code: completion.status === 401 ? 'LLMAuthenticationError' : 'LLMServiceUnavailableError',
          detail: completion.body,
        })
        return
      }
      const { toolCall } = completion
      if (!toolCall) {
        conversation.history.push({ role: 'assistant', content: completion.text })
        emit(conversation, 'MessageEvent', {
          source: 'agent',
          llm_message: { role: 'assistant', content: text(completion.text) },
        })
        status(conversation, 'finished')
        return
      }
      const name = toolCall.function.name
      const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
      conversation.history.push({ role: 'assistant', content: completion.text, tool_calls: [toolCall] })
      const isMcp = conversation.mcpServerOfTool?.[name] !== undefined
      const action = emit(conversation, 'ActionEvent', {
        source: 'agent',
        thought: text(completion.text),
        reasoning_content: completion.reasoning || null,
        action: isMcp ? { kind: 'MCPToolAction', data: args } : actionOf(name, args),
        tool_name: name,
        tool_call_id: toolCall.id,
        tool_call: { id: toolCall.id, name, arguments: toolCall.function.arguments },
      })
      const observation = isMcp
        ? await observeMcp(conversation, name, args)
        : await observe(name, args, directoryOf(conversation.apiKey))
      conversation.history.push({ role: 'tool', tool_call_id: toolCall.id, content: textOf(observation) })
      emitLive('ObservationEvent', { source: 'environment', action_id: action.id, tool_name: name, observation })
    }
  }
  const fake = {
    conversations,
    prompts,
    connections,
    interrupts,
    turn: modelCall ? scriptedTurn : defaultTurn,
    onInterrupt: (conversation: Conversation) => {
      conversation.turnAbort?.abort()
      status(conversation, 'paused')
    },
    emit,
    status,
    beginTurn,
    finishTurn,
    agentServer: {
      respond: ({ method, path, headers, body }, container) => {
        if (headers?.['x-session-api-key'] !== container.apiKey) return { status: 401, body: '' }
        if (method === 'POST' && path === '/api/conversations') {
          const id = crypto.randomUUID()
          const created = JSON.parse(body ?? '{}')
          const llm = created.agent?.llm ?? {}
          conversations.set(id, {
            id,
            apiKey: container.apiKey,
            created,
            llmsByUsageId: new Map([[llm.usage_id, llm]]),
            events: [],
            executionStatus: 'idle',
            listeners: new Set(),
            closers: new Set(),
            history: [{ role: 'system', content: 'You are a fake agent.' }],
          })
          return { status: 201, body: JSON.stringify({ id, execution_status: 'idle' }) }
        }
        const [, conversationId = '', action = ''] = path.match(/^\/api\/conversations\/([^/]+)\/?(.*)$/) ?? []
        const conversation = conversations.get(conversationId)
        if (!conversation) return { status: 404, body: '' }
        if (method === 'GET' && action === '')
          return {
            status: 200,
            body: JSON.stringify({ id: conversation.id, execution_status: conversation.executionStatus }),
          }
        if (method === 'GET' && action === 'agent_final_response') {
          const answer = conversation.events.findLast(
            (event) => event.kind === 'MessageEvent' && event.source === 'agent',
          )
          const response = textOf((answer?.llm_message ?? { content: [] }) as { content: { text: string }[] })
          return { status: 200, body: JSON.stringify({ response }) }
        }
        if (method === 'POST' && action === 'interrupt') {
          interrupts.push(conversation.id)
          fake.onInterrupt(conversation)
          return { status: 200, body: JSON.stringify({ success: true }) }
        }
        if (method === 'POST' && action === 'switch_llm') {
          const { llm } = JSON.parse(body ?? '{}')
          if (!conversation.llmsByUsageId.has(llm.usage_id)) conversation.llmsByUsageId.set(llm.usage_id, llm)
          ;(conversation.created.agent as { llm: object }).llm = conversation.llmsByUsageId.get(llm.usage_id) ?? llm
          return { status: 200, body: JSON.stringify({ success: true }) }
        }
        if (method !== 'POST' || action !== 'events') return { status: 404, body: '' }
        const prompt = (JSON.parse(body ?? '{}') as { content: { text: string }[] }).content[0]?.text ?? ''
        prompts.push({ conversationId: conversation.id, text: prompt })
        void fake.turn(conversation, prompt)
        return { status: 200, body: JSON.stringify({ success: true }) }
      },
      stopped: (container: FakeContainer) => {
        if (!modelCall) return
        for (const conversation of conversations.values())
          if (conversation.apiKey === container.apiKey) {
            conversation.turnAbort?.abort()
            conversation.executionStatus = 'idle'
            for (const close of [...conversation.closers]) close()
          }
      },
      connect: ({ path, send, close }) => {
        const url = new URL(path, 'http://agent-server')
        const conversation = conversations.get(url.pathname.split('/').at(-1) ?? '')
        const listener = (event: Event) => send(JSON.stringify(event))
        if (conversation) conversation.closers.add(close)
        return {
          onMessage: (data) => {
            if (!conversation || conversation.listeners.has(listener)) return
            const auth = JSON.parse(data)
            connections.push({ conversationId: conversation.id, query: url.search, auth })
            if (auth.session_api_key !== conversation.apiKey) return close()
            const fullState = { kind: 'ConversationStateUpdateEvent', key: 'full_state', value: {} }
            send(JSON.stringify({ id: crypto.randomUUID(), timestamp: '2026-10-05T20:00:00.000000', ...fullState }))
            const after = url.searchParams.get('after_timestamp') ?? ''
            if (url.searchParams.get('resend_mode') === 'all') conversation.events.forEach(listener)
            if (url.searchParams.get('resend_mode') === 'since')
              for (const event of conversation.events) if (event.timestamp >= after) listener(event)
            conversation.listeners.add(listener)
          },
          onClose: () => {
            conversation?.listeners.delete(listener)
            conversation?.closers.delete(close)
          },
        }
      },
    } satisfies FakeAgentServer,
  }
  return fake
}

export type FakeAgent = ReturnType<typeof createFakeAgentServer>
