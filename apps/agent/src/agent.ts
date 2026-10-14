import type { ServerWebSocket } from 'bun'
import { AcpError, type AdapterConnection, connectAdapter, type Json, methodNotFound } from './acp.ts'

type Status = 'starting' | 'idle' | 'running' | 'finished' | 'error'
type AgentEvent = { id: string; seq: number; timestamp: string; completed: boolean; update: Json }
type SocketData = { conversationId: string; after: number; isAuthenticated: boolean }
type Conversation = {
  id: string
  connection: AdapterConnection
  status: Status
  failure?: string
  sessionId?: string
  isLoading: boolean
  configOptions: Json[]
  events: AgentEvent[]
  lastSeq: number
  toolCalls: Map<string, Json>
  sockets: Set<ServerWebSocket<SocketData>>
}
type Launch = {
  agent?: {
    acp_command?: unknown
    mcp_config?: Record<string, { url: string; headers?: Record<string, string> }>
    acp_resume_session_id?: string
    acp_model?: string
    acp_thought_level?: string
  }
  secrets?: Record<string, { value?: string }>
  workspace?: { working_dir?: string }
}

const inheritedEnvironment = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'CLAUDE_CODE_EXECUTABLE', 'CODEX_PATH']
const defaultWorkingDirectory = '/workspace/project'
const bypassMode = 'bypassPermissions'
const terminalToolStatuses = ['completed', 'failed']
const conversationRoute = /^\/api\/conversations\/([\w-]+)(?:\/(events|interrupt|switch_acp_model))?$/
const socketRoute = /^\/sockets\/events\/([\w-]+)$/

const adapterEnvironmentOf = (secrets: Launch['secrets']) => ({
  ...Object.fromEntries(inheritedEnvironment.flatMap((name) => (process.env[name] ? [[name, process.env[name]]] : []))),
  ...Object.fromEntries(Object.entries(secrets ?? {}).map(([name, secret]) => [name, String(secret?.value ?? '')])),
})

const mcpServersOf = (config: NonNullable<Launch['agent']>['mcp_config']) =>
  Object.entries(config ?? {}).map(([name, { url, headers }]) => ({
    type: 'http',
    name,
    url,
    headers: Object.entries(headers ?? {}).map(([header, value]) => ({ name: header, value })),
  }))

const errorUpdateOf = (error: unknown) => ({
  sessionUpdate: 'error',
  message: error instanceof AcpError ? error.message : 'hq-agent failed',
  ...(error instanceof AcpError && error.code !== undefined && { code: error.code }),
})

const isLive = (update: Json) =>
  String(update.sessionUpdate).endsWith('_chunk') || String(update.sessionUpdate).startsWith('tool_call')

const definedFieldsOf = (update: Json) =>
  Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null))

const terminalOutputOf = (previous: Json | undefined, update: Json) => {
  const meta = update._meta as
    | { terminal_output?: { data?: string }; terminal_exit?: { exit_code?: number | null } }
    | undefined
  if (!meta?.terminal_output && !meta?.terminal_exit) return {}
  const output = (previous?.rawOutput ?? {}) as Json
  return {
    rawOutput: {
      ...output,
      formatted_output: `${output.formatted_output ?? ''}${meta.terminal_output?.data ?? ''}`,
      ...(meta.terminal_exit && { exit_code: meta.terminal_exit.exit_code }),
    },
  }
}

export const startAgent = ({
  apiKey,
  port,
  bufferSize = 10_000,
}: {
  apiKey: string
  port: number
  bufferSize?: number
}) => {
  const conversations = new Map<string, Conversation>()

  const emit = (conversation: Conversation, update: Json, completed = !isLive(update)) => {
    const seq = ++conversation.lastSeq
    const event = { id: `${conversation.id}:${seq}`, seq, timestamp: new Date().toISOString(), completed, update }
    conversation.events.push(event)
    if (conversation.events.length > bufferSize) conversation.events.shift()
    const frame = JSON.stringify(event)
    for (const socket of conversation.sockets) socket.send(frame)
  }

  const fail = (conversation: Conversation, error: unknown) => {
    if (conversation.status === 'error') return
    const update = errorUpdateOf(error)
    conversation.status = 'error'
    conversation.failure = update.message
    emit(conversation, update)
  }

  const onUpdate = (conversation: Conversation, update: Json) => {
    if (conversation.isLoading) return
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions))
      conversation.configOptions = update.configOptions
    if (update.sessionUpdate === 'tool_call') conversation.toolCalls.set(String(update.toolCallId), update)
    if (update.sessionUpdate !== 'tool_call_update') return emit(conversation, update)
    const previous = conversation.toolCalls.get(String(update.toolCallId))
    const merged = { ...previous, ...definedFieldsOf(update), ...terminalOutputOf(previous, update) }
    if (!terminalToolStatuses.includes(String(update.status))) {
      conversation.toolCalls.set(String(update.toolCallId), merged)
      return emit(conversation, update)
    }
    conversation.toolCalls.delete(String(update.toolCallId))
    emit(conversation, { ...merged, sessionUpdate: 'tool_call_update' }, true)
  }

  const setConfigOption = async (conversation: Conversation, category: string, value: string) => {
    const option = conversation.configOptions.find((candidate) => candidate.category === category)
    if (!option || !conversation.sessionId) return false
    const result = await conversation.connection.request('session/set_config_option', {
      sessionId: conversation.sessionId,
      configId: option.id,
      value,
    })
    if (Array.isArray(result.configOptions)) conversation.configOptions = result.configOptions
    return true
  }

  const switchModel = async (conversation: Conversation, model: string, thoughtLevel?: string) => {
    if (!(await setConfigOption(conversation, 'model', model))) throw new AcpError('The adapter lists no models')
    const thoughtLevels = (conversation.configOptions.find((option) => option.category === 'thought_level')?.options ??
      []) as { value?: string }[]
    if (thoughtLevel && thoughtLevels.some((level) => level.value === thoughtLevel))
      await setConfigOption(conversation, 'thought_level', thoughtLevel)
    emit(conversation, { sessionUpdate: 'config_option_update', configOptions: conversation.configOptions })
  }

  const start = async (conversation: Conversation, { agent, workspace }: Launch) => {
    const { connection } = conversation
    const sessionParams = {
      cwd: workspace?.working_dir ?? defaultWorkingDirectory,
      mcpServers: mcpServersOf(agent?.mcp_config),
    }
    const { agentCapabilities } = await connection.request('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const canLoad = Boolean((agentCapabilities as Json | undefined)?.loadSession)
    const load = (params: Json) => {
      conversation.isLoading = true
      return connection.request('session/load', params).finally(() => {
        conversation.isLoading = false
      })
    }
    const reopen = (params: Json) =>
      connection
        .request('session/resume', params)
        .catch((error) =>
          canLoad && error instanceof AcpError && error.code === methodNotFound ? load(params) : Promise.reject(error),
        )
    const resumeSessionId = agent?.acp_resume_session_id
    const resumed =
      resumeSessionId &&
      (await reopen({ sessionId: resumeSessionId, ...sessionParams })
        .then((result): Json => ({ ...result, sessionId: resumeSessionId }))
        .catch(() => undefined))
    const session = resumed || (await connection.request('session/new', sessionParams))
    const sessionId = String(session.sessionId)
    const modes = session.modes as { availableModes?: { id: string }[] } | undefined
    if (modes?.availableModes?.some((mode) => mode.id === bypassMode))
      await connection.request('session/set_mode', { sessionId, modeId: bypassMode })
    conversation.sessionId = sessionId
    conversation.configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
    emit(conversation, {
      sessionUpdate: 'session_started',
      sessionId,
      resumeFailed: Boolean(resumeSessionId) && !resumed,
      models: session.models,
      modes: session.modes,
      configOptions: conversation.configOptions,
    })
    if (agent?.acp_model) await switchModel(conversation, agent.acp_model, agent.acp_thought_level)
    conversation.status = 'idle'
  }

  const create = async (launch: Launch) => {
    const command = launch.agent?.acp_command
    if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string'))
      return Response.json({ error: 'agent.acp_command must be a list of strings' }, { status: 400 })
    const id = crypto.randomUUID()
    const conversation: Conversation = {
      id,
      status: 'starting',
      isLoading: false,
      configOptions: [],
      events: [],
      lastSeq: 0,
      toolCalls: new Map(),
      sockets: new Set(),
      connection: connectAdapter(
        {
          command,
          env: adapterEnvironmentOf(launch.secrets),
          cwd: launch.workspace?.working_dir ?? defaultWorkingDirectory,
        },
        {
          onUpdate: (params) => onUpdate(conversation, (params.update ?? {}) as Json),
          onExit: (code) => {
            if (conversations.get(id) === conversation)
              fail(conversation, new AcpError(`The adapter exited with code ${code}`))
          },
        },
      ),
    }
    conversations.set(id, conversation)
    await start(conversation, launch).catch((error) => {
      fail(conversation, error)
      conversation.connection.close()
    })
    return Response.json({ id, ...summaryOf(conversation) }, { status: 201 })
  }

  const summaryOf = (conversation: Conversation) => ({
    execution_status: conversation.status,
    acp_session_id: conversation.sessionId,
    error: conversation.failure,
  })

  const prompt = (conversation: Conversation, body: { content?: { type?: string; text?: string }[] }) => {
    if (!conversation.sessionId || conversation.status === 'error')
      return Response.json({ error: 'The conversation has no running session' }, { status: 409 })
    conversation.status = 'running'
    void conversation.connection
      .request('session/prompt', {
        sessionId: conversation.sessionId,
        prompt: (body.content ?? [])
          .filter((block) => block.type === 'text')
          .map(({ text }) => ({ type: 'text', text })),
      })
      .then(
        (result) => {
          conversation.status = 'finished'
          emit(conversation, { sessionUpdate: 'turn_end', stopReason: result.stopReason })
        },
        (error) => {
          if (conversation.status !== 'error') {
            conversation.status = 'finished'
            emit(conversation, errorUpdateOf(error))
          }
          emit(conversation, { sessionUpdate: 'turn_end', stopReason: 'error' })
        },
      )
    return Response.json({})
  }

  const remove = (conversation: Conversation) => {
    conversations.delete(conversation.id)
    conversation.connection.close()
    for (const socket of conversation.sockets) socket.close()
    return Response.json({})
  }

  const route = async (method: string, pathname: string, request: Request) => {
    if (method === 'POST' && pathname === '/api/conversations') return create(await request.json())
    const [, conversationId = '', action] = conversationRoute.exec(pathname) ?? []
    const conversation = conversations.get(conversationId)
    if (!conversation) return Response.json({ error: 'Not found' }, { status: 404 })
    if (method === 'GET' && !action) return Response.json({ id: conversation.id, ...summaryOf(conversation) })
    if (method === 'DELETE' && !action) return remove(conversation)
    if (method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 })
    if (action === 'events') return prompt(conversation, await request.json())
    if (action === 'interrupt') {
      if (conversation.sessionId)
        conversation.connection.notify('session/cancel', { sessionId: conversation.sessionId })
      return Response.json({})
    }
    if (action === 'switch_acp_model') {
      const { model, thoughtLevel } = (await request.json()) as { model?: string; thoughtLevel?: string }
      await switchModel(conversation, String(model), thoughtLevel)
      return Response.json({})
    }
    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  const server = Bun.serve({
    port,
    fetch: async (request, server) => {
      const { pathname, searchParams } = new URL(request.url)
      if (request.method === 'GET' && pathname === '/ready') return Response.json({ status: 'ready' })
      const [, socketConversationId] = socketRoute.exec(pathname) ?? []
      if (socketConversationId) {
        if (!conversations.has(socketConversationId)) return Response.json({ error: 'Not found' }, { status: 404 })
        const after = Number(searchParams.get('after') ?? 0)
        const data = {
          conversationId: socketConversationId,
          after: Number.isSafeInteger(after) ? after : 0,
          isAuthenticated: false,
        }
        return server.upgrade(request, { data })
          ? undefined
          : Response.json({ error: 'Upgrade failed' }, { status: 400 })
      }
      if (request.headers.get('x-session-api-key') !== apiKey)
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      return route(request.method, pathname, request).catch((error) =>
        Response.json({ error: errorUpdateOf(error).message }, { status: 502 }),
      )
    },
    websocket: {
      data: {} as SocketData,
      message: (socket, message) => {
        if (socket.data.isAuthenticated) return
        const conversation = conversations.get(socket.data.conversationId)
        const auth = (() => {
          try {
            return JSON.parse(String(message))
          } catch {
            return undefined
          }
        })()
        if (!conversation || auth?.type !== 'auth' || auth.session_api_key !== apiKey)
          return void socket.close(1008, 'Unauthorized')
        socket.data.isAuthenticated = true
        for (const event of conversation.events) if (event.seq > socket.data.after) socket.send(JSON.stringify(event))
        conversation.sockets.add(socket)
      },
      close: (socket) => {
        conversations.get(socket.data.conversationId)?.sockets.delete(socket)
      },
    },
  })

  return {
    port: Number(server.port),
    stop: () => {
      for (const conversation of conversations.values()) remove(conversation)
      void server.stop(true)
    },
  }
}
