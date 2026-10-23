import { timingSafeEqual } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import {
  AcpError,
  type AdapterConnection,
  type AdapterRequest,
  connectAdapter,
  type Json,
  liveOutputCharacters,
} from './acp.ts'
import { checkOut, lastLinesOf, type Repository, runSetup, setupCommand } from './checkout.ts'
import { connectPi } from './pi.ts'
import { contextOf, log, withSpan } from './telemetry.ts'
import { bundleOf, changesOf, commitOf, fileOf, mediaOf, mergeOf, pushedOf, statusOf, treeOf } from './workspace.ts'

type Status = 'starting' | 'idle' | 'running' | 'finished' | 'error'
type AgentEvent = { id: string; seq: number; timestamp: string; completed: boolean; update: Json }
type BufferedEvent = { seq: number; frame: string; bytes: number }
type SocketData = { conversationId: string; after: number; isAuthenticated: boolean }
type Answer = {
  answers?: Record<string, string | string[]>
  free?: Record<string, string>
  approve?: boolean
  answeredBy?: string
}
type PendingQuestion = PromiseWithResolvers<Json> & {
  requestId: number | string
  update: Json
  resultOf: (answer: Answer) => Json | undefined
  cancelled: Json
}
type FormChoice = { const?: string; title?: string; description?: string }
type FormField = Partial<Record<'title' | 'description', string>> & {
  type?: string
  oneOf?: FormChoice[]
  items?: { anyOf?: FormChoice[] }
}
type FormShape = { free: string; header: 'title' | 'description'; text: 'title' | 'description'; none?: string }
type PermissionOption = { optionId: string; kind?: string }
type Conversation = {
  id: string
  connection: AdapterConnection
  status: Status
  failure?: string
  sessionId?: string
  isSub: boolean
  cwd: string
  workspace?: AgentEvent
  modeId?: string
  modeIds: string[]
  modeAfterPlan?: string
  keptPlanning: boolean
  questions: Map<string, PendingQuestion>
  configOptions: Json[]
  events: BufferedEvent[]
  bufferedBytes: number
  lastSeq: number
  toolCalls: Map<string, Json>
  sockets: Set<ServerWebSocket<SocketData>>
  started: Promise<void>
}
type Launch = {
  id?: string
  agent?: {
    acp_command?: unknown
    adapter?: string
    mcp_config?: Record<string, { url: string; headers?: Record<string, string> }>
    acp_resume_session_id?: string
    acp_model?: string
    acp_thought_level?: string
  }
  secrets?: Record<string, { value?: string }>
  workspace?: { working_dir?: string }
  repository?: Repository
  parent_conversation_id?: string
}

const inheritedEnvironment = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'CLAUDE_CODE_EXECUTABLE', 'CODEX_PATH']
const permissiveModes = ['bypassPermissions', 'agent-full-access']
const planMode = 'plan'
const collaborationMode = 'collaboration_mode'
const planOptionIds = { approve: ['exit-plan-bypass', 'implement_plan'], keepPlanning: ['reject', 'revise_plan'] }
export const formShapes: Record<'claude-code' | 'codex', FormShape> = {
  'claude-code': { free: '_custom', header: 'title', text: 'description' },
  codex: { free: '_note', header: 'description', text: 'title', none: 'None of the above' },
}
const subAnswerText = 'No member is available; decide yourself and state your assumption.'
const cancelledPermission = { outcome: { outcome: 'cancelled' } }
const terminalToolStatuses = ['completed', 'failed']
const conversationRoute =
  /^\/api\/conversations\/([\w-]+)(?:\/(events|interrupt|switch_acp_model|plan_mode)|\/questions\/([\w-]+))?$/
const socketRoute = /^\/sockets\/events\/([\w-]+)$/
const workspaceRoute = /^\/api\/workspace\/(tree|file|media|changes|status)$/
const workspaceActions = { bundle: bundleOf, commit: commitOf, merge: mergeOf, pushed: pushedOf }
const workspaceActionRoute = /^\/api\/workspace\/(bundle|commit|merge|pushed)$/
const setupToolCallId = 'spyria-setup'
const conversationIdPattern = /^[\w-]{1,64}$/

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
  message: error instanceof AcpError ? error.message : 'spyria-agent failed',
  ...(error instanceof AcpError && error.code !== undefined && { code: error.code }),
})

const branchOf = async (cwd: string) => {
  try {
    const git = Bun.spawn(['git', '-C', cwd, 'branch', '--show-current'], {
      env: adapterEnvironmentOf({}),
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const branch = (await new Response(git.stdout).text()).trim()
    return (await git.exited) === 0 && branch ? branch : undefined
  } catch {
    return undefined
  }
}

const isLive = (update: Json) =>
  String(update.sessionUpdate).endsWith('_chunk') || String(update.sessionUpdate).startsWith('tool_call')

const definedFieldsOf = (update: Json) =>
  Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null))

const modeOf = (configOptions: Json[]) =>
  configOptions.find((option) => option.category === 'mode')?.currentValue as string | undefined

const formOf = (params: Json) => {
  const properties = ((params.requestedSchema as Json | undefined)?.properties ?? {}) as Record<string, FormField>
  const ids = Object.keys(properties).filter((id) => properties[id]?.oneOf ?? properties[id]?.items?.anyOf)
  const shape =
    Object.values(formShapes).find(({ free }) => ids.some((id) => `${id}${free}` in properties)) ??
    formShapes['claude-code']
  const questions = ids.map((id) => {
    const field = properties[id] ?? {}
    return definedFieldsOf({
      id,
      header: field[shape.header],
      text: field[shape.text] ?? params.message,
      options: (field.oneOf ?? field.items?.anyOf ?? [])
        .filter((choice) => choice.const !== shape.none)
        .map(({ const: value, title, description }) => definedFieldsOf({ value, label: title ?? value, description })),
      multi: field.type === 'array',
      free: `${id}${shape.free}` in properties,
    })
  })
  return { shape, questions }
}

const formResultOf = (shape: FormShape, questions: Json[], { answers = {}, free = {} }: Answer) => {
  const content = Object.fromEntries(
    questions.flatMap(({ id, free: hasFree }) => {
      const freeText = hasFree ? free[String(id)] : undefined
      const picked = answers[String(id)] ?? (freeText ? shape.none : undefined)
      return [...(picked === undefined ? [] : [[id, picked]]), ...(freeText ? [[`${id}${shape.free}`, freeText]] : [])]
    }),
  )
  return Object.keys(content).length > 0 ? { action: 'accept', content } : { action: 'decline' }
}

const selectedOf = (params: Json, isChosen: (option: PermissionOption) => boolean) => {
  const optionId = ((params.options ?? []) as PermissionOption[]).find(isChosen)?.optionId
  return optionId ? { outcome: { outcome: 'selected', optionId } } : cancelledPermission
}

const planOf = (...toolCalls: (Json | undefined)[]) =>
  toolCalls
    .map(
      (toolCall) =>
        (toolCall?.rawInput as Json | undefined)?.plan ??
        (toolCall?.content as { content?: { text?: string } }[] | undefined)?.[0]?.content?.text,
    )
    .find((plan) => typeof plan === 'string')

export const startAgent = ({
  apiKey,
  port,
  bufferSize = 10_000,
  bufferBytes = 8 * 1024 * 1024,
  authTimeoutMilliseconds = 5_000,
  requestTimeoutMilliseconds = 60_000,
  workspaceDirectory = '/workspace/project',
}: {
  apiKey: string
  port: number
  bufferSize?: number
  bufferBytes?: number
  authTimeoutMilliseconds?: number
  requestTimeoutMilliseconds?: number
  workspaceDirectory?: string
}) => {
  const conversations = new Map<string, Conversation>()
  const checkouts = new Map<string, ReturnType<typeof checkOut>>()
  const apiKeyBytes = Buffer.from(apiKey)
  const isApiKey = (given: unknown) => {
    const givenBytes = Buffer.from(String(given ?? ''))
    return givenBytes.length === apiKeyBytes.length && timingSafeEqual(givenBytes, apiKeyBytes)
  }

  const emit = (conversation: Conversation, update: Json, completed = !isLive(update)) => {
    const seq = ++conversation.lastSeq
    const event = { id: `${conversation.id}:${seq}`, seq, timestamp: new Date().toISOString(), completed, update }
    const frame = JSON.stringify(event)
    const bytes = Buffer.byteLength(frame)
    conversation.events.push({ seq, frame, bytes })
    conversation.bufferedBytes += bytes
    if (update.sessionUpdate === 'workspace') conversation.workspace = event
    while (
      conversation.events.length > 1 &&
      (conversation.events.length > bufferSize || conversation.bufferedBytes > bufferBytes)
    )
      conversation.bufferedBytes -= conversation.events.shift()?.bytes ?? 0
    for (const socket of conversation.sockets) socket.send(frame)
  }

  const reportWorkspace = async (conversation: Conversation) => {
    if (conversation.isSub) return
    const { cwd } = conversation
    const update = definedFieldsOf({ sessionUpdate: 'workspace', cwd, branch: await branchOf(cwd) })
    if (JSON.stringify(update) !== JSON.stringify(conversation.workspace?.update)) emit(conversation, update, false)
  }

  const fail = (conversation: Conversation, error: unknown) => {
    if (conversation.status === 'error') return
    const update = errorUpdateOf(error)
    conversation.status = 'error'
    conversation.failure = update.message
    emit(conversation, update)
  }

  const requestWithin = (conversation: Conversation, method: string, params: Json) => {
    const expired = Promise.withResolvers<never>()
    const timer = setTimeout(() => {
      const error = new AcpError(`The adapter did not answer ${method} within ${requestTimeoutMilliseconds} ms`)
      fail(conversation, error)
      conversation.connection.close()
      expired.reject(error)
    }, requestTimeoutMilliseconds)
    return Promise.race([conversation.connection.request(method, params), expired.promise]).finally(() =>
      clearTimeout(timer),
    )
  }

  const answer = (conversation: Conversation, pending: PendingQuestion, body: Answer) => {
    const result = pending.resultOf(body)
    if (!result) return false
    conversation.questions.delete(String(pending.update.questionId))
    pending.resolve(result)
    const isPlan = pending.update.kind === 'plan'
    if (isPlan) conversation.keptPlanning = !body.approve
    emit(conversation, {
      sessionUpdate: 'question_answered',
      ...pending.update,
      ...(isPlan ? { approved: body.approve } : { answers: body.answers ?? {}, ...(body.free && { free: body.free }) }),
      ...(typeof body.answeredBy === 'string' && { answeredBy: body.answeredBy }),
    })
    return true
  }

  const closeQuestions = (conversation: Conversation, reason: string, requestId?: number | string) => {
    for (const [questionId, pending] of conversation.questions)
      if (requestId === undefined || pending.requestId === requestId) {
        conversation.questions.delete(questionId)
        pending.resolve(pending.cancelled)
        emit(conversation, { sessionUpdate: 'question_closed', ...pending.update, reason })
      }
  }

  const ask = (
    conversation: Conversation,
    requestId: number | string,
    question: Json,
    { resultOf, cancelled, subAnswer }: Pick<PendingQuestion, 'resultOf' | 'cancelled'> & { subAnswer: Answer },
  ) => {
    const pending = {
      ...Promise.withResolvers<Json>(),
      requestId,
      update: definedFieldsOf({ questionId: crypto.randomUUID(), ...question }),
      resultOf,
      cancelled,
    }
    conversation.questions.set(String(pending.update.questionId), pending)
    if (conversation.isSub) answer(conversation, pending, subAnswer)
    else emit(conversation, { sessionUpdate: 'question', ...pending.update }, false)
    return pending.promise
  }

  const onRequest = (conversation: Conversation, { id, method, params }: AdapterRequest) => {
    if (method === 'elicitation/create') {
      if (params.mode !== 'form') return Promise.resolve({ action: 'decline' })
      const { shape, questions } = formOf(params)
      return ask(
        conversation,
        id,
        { toolCallId: params.toolCallId, kind: 'question', questions },
        {
          resultOf: (body) => (body.approve === undefined ? formResultOf(shape, questions, body) : undefined),
          cancelled: { action: 'cancel' },
          subAnswer: { free: Object.fromEntries(questions.map((question) => [String(question.id), subAnswerText])) },
        },
      )
    }
    if (method !== 'session/request_permission') return undefined
    const toolCall = (params.toolCall ?? {}) as Json
    if (toolCall.kind === 'switch_mode')
      return ask(
        conversation,
        id,
        {
          toolCallId: toolCall.toolCallId,
          kind: 'plan',
          plan: planOf(toolCall, conversation.toolCalls.get(String(toolCall.toolCallId))),
        },
        {
          resultOf: (body) =>
            typeof body.approve === 'boolean'
              ? selectedOf(params, ({ optionId }) =>
                  planOptionIds[body.approve ? 'approve' : 'keepPlanning'].includes(optionId),
                )
              : undefined,
          cancelled: cancelledPermission,
          subAnswer: { approve: true },
        },
      )
    if (conversation.modeId === planMode)
      return Promise.resolve(selectedOf(params, ({ kind }) => Boolean(kind?.startsWith('reject'))))
    return undefined
  }

  const onUpdate = (conversation: Conversation, update: Json) => {
    if (update.sessionUpdate === 'current_mode_update') conversation.modeId = String(update.currentModeId)
    if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
      conversation.configOptions = update.configOptions
      conversation.modeId = modeOf(update.configOptions) ?? conversation.modeId
    }
    if (update.sessionUpdate === 'tool_call') conversation.toolCalls.set(String(update.toolCallId), update)
    if (update.sessionUpdate !== 'tool_call_update') return emit(conversation, update)
    const previous = conversation.toolCalls.get(String(update.toolCallId))
    const merged = { ...previous, ...definedFieldsOf(update) }
    if (!terminalToolStatuses.includes(String(update.status))) {
      conversation.toolCalls.set(String(update.toolCallId), merged)
      return emit(conversation, update)
    }
    conversation.toolCalls.delete(String(update.toolCallId))
    emit(conversation, { ...merged, sessionUpdate: 'tool_call_update' }, true)
  }

  const setConfigOption = async (conversation: Conversation, key: string, value: string) => {
    const option = conversation.configOptions.find((candidate) => candidate.category === key || candidate.id === key)
    if (!option || !conversation.sessionId) return false
    const result = await requestWithin(conversation, 'session/set_config_option', {
      sessionId: conversation.sessionId,
      configId: option.id,
      value,
    })
    if (Array.isArray(result.configOptions)) conversation.configOptions = result.configOptions
    return true
  }

  const switchModel = async (conversation: Conversation, model?: string, thoughtLevel?: string) => {
    if (model && !(await setConfigOption(conversation, 'model', model)))
      throw new AcpError('The adapter lists no models')
    const thoughtLevels = (conversation.configOptions.find((option) => option.category === 'thought_level')?.options ??
      []) as { value?: string }[]
    if (thoughtLevel && thoughtLevels.some((level) => level.value === thoughtLevel))
      await setConfigOption(conversation, 'thought_level', thoughtLevel)
    emit(conversation, { sessionUpdate: 'config_option_update', configOptions: conversation.configOptions })
  }

  const setPlanMode = async (conversation: Conversation, enabled: boolean) => {
    if (await setConfigOption(conversation, collaborationMode, enabled ? planMode : 'default')) {
      emit(conversation, { sessionUpdate: 'config_option_update', configOptions: conversation.configOptions })
      return true
    }
    if (!conversation.sessionId || !conversation.modeIds.includes(planMode)) return false
    if (enabled && conversation.modeId !== planMode) conversation.modeAfterPlan = conversation.modeId
    const modeId = enabled ? planMode : (conversation.modeAfterPlan ?? 'default')
    await requestWithin(conversation, 'session/set_mode', { sessionId: conversation.sessionId, modeId })
    conversation.modeId = modeId
    emit(conversation, { sessionUpdate: 'current_mode_update', currentModeId: modeId })
    return true
  }

  const start = async (conversation: Conversation, { agent }: Launch) => {
    const request = (method: string, params: Json) => requestWithin(conversation, method, params)
    const sessionParams = {
      cwd: conversation.cwd,
      mcpServers: mcpServersOf(agent?.mcp_config),
    }
    await request('initialize', { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } })
    const resumeSessionId = agent?.acp_resume_session_id
    const resumed =
      resumeSessionId &&
      (await request('session/resume', { sessionId: resumeSessionId, ...sessionParams })
        .then((result): Json => ({ ...result, sessionId: resumeSessionId }))
        .catch(() => undefined))
    const session = resumed || (await request('session/new', sessionParams))
    const sessionId = String(session.sessionId)
    const modes = session.modes as { currentModeId?: string; availableModes?: { id: string }[] } | undefined
    const permissiveMode = permissiveModes.find((modeId) => modes?.availableModes?.some((mode) => mode.id === modeId))
    if (permissiveMode) await request('session/set_mode', { sessionId, modeId: permissiveMode })
    conversation.sessionId = sessionId
    conversation.configOptions = Array.isArray(session.configOptions) ? session.configOptions : []
    conversation.modeId = permissiveMode ?? modes?.currentModeId ?? modeOf(conversation.configOptions)
    conversation.modeIds = modes?.availableModes?.map((mode) => mode.id) ?? []
    conversation.modeAfterPlan = conversation.modeId
    emit(conversation, {
      sessionUpdate: 'session_started',
      sessionId,
      resumeFailed: Boolean(resumeSessionId) && !resumed,
      models: session.models,
      modes: session.modes,
      configOptions: conversation.configOptions,
    })
    if (agent?.acp_model || agent?.acp_thought_level)
      await switchModel(conversation, agent.acp_model, agent.acp_thought_level)
    await reportWorkspace(conversation)
    conversation.status = 'idle'
  }

  const setUp = async (conversation: Conversation) => {
    const call = { toolCallId: setupToolCallId, title: setupCommand, kind: 'execute' }
    emit(conversation, { sessionUpdate: 'tool_call', ...call, status: 'in_progress' })
    const { exitCode, output } = await runSetup(conversation.cwd, adapterEnvironmentOf({}), (soFar) =>
      emit(conversation, {
        sessionUpdate: 'tool_call_update',
        toolCallId: setupToolCallId,
        status: 'in_progress',
        rawOutput: { formatted_output: soFar.slice(-liveOutputCharacters) },
      }),
    )
    emit(
      conversation,
      {
        sessionUpdate: 'tool_call_update',
        ...call,
        status: exitCode === 0 ? 'completed' : 'failed',
        rawOutput: { formatted_output: output, exit_code: exitCode },
      },
      true,
    )
    if (exitCode !== 0) emit(conversation, { sessionUpdate: 'setup_failed', exitCode, output: lastLinesOf(output) })
  }

  const readWorkspace = async (read: string, parameters: URLSearchParams) => {
    const environment = adapterEnvironmentOf({})
    const path = parameters.get('path') ?? ''
    if (read === 'tree') return Response.json(await treeOf(workspaceDirectory, path, environment))
    if (read === 'changes' || read === 'status')
      return Response.json(
        await (read === 'changes' ? changesOf : statusOf)(
          workspaceDirectory,
          parameters.get('base') ?? '',
          environment,
        ),
      )
    if (read === 'media') {
      const media = await mediaOf(workspaceDirectory, path)
      if (media && 'isTooLarge' in media) return Response.json({ error: 'Too large' }, { status: 413 })
      return media ? Response.json(media) : Response.json({ error: 'Not found' }, { status: 404 })
    }
    const file = await fileOf(workspaceDirectory, path)
    return file ? Response.json(file) : Response.json({ error: 'Not found' }, { status: 404 })
  }

  const checkedOut = (id: string, cwd: string, repository: Repository) => {
    const checkout = checkouts.get(id) ?? checkOut(cwd, repository, adapterEnvironmentOf({}))
    checkouts.set(id, checkout)
    return checkout.finally(() => checkouts.delete(id))
  }

  const create = async (launch: Launch) => {
    const command = launch.agent?.acp_command
    if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === 'string'))
      return Response.json({ error: 'agent.acp_command must be a list of strings' }, { status: 400 })
    if (launch.id !== undefined && !conversationIdPattern.test(String(launch.id)))
      return Response.json({ error: 'id must be letters, digits, - or _' }, { status: 400 })
    const known = launch.id === undefined ? undefined : conversations.get(launch.id)
    if (known) {
      await known.started
      return Response.json({ id: known.id, ...summaryOf(known) })
    }
    const id = launch.id ?? crypto.randomUUID()
    const cwd = launch.workspace?.working_dir ?? workspaceDirectory
    const { failure, hasSetup } =
      launch.repository && !launch.parent_conversation_id ? await checkedOut(id, cwd, launch.repository) : {}
    const raced = conversations.get(id)
    if (raced) {
      await raced.started
      return Response.json({ id, ...summaryOf(raced) })
    }
    if (failure) return Response.json({ id, execution_status: 'error', error: failure }, { status: 201 })
    const conversation: Conversation = {
      id,
      status: 'starting',
      isSub: Boolean(launch.parent_conversation_id),
      cwd,
      modeIds: [],
      keptPlanning: false,
      questions: new Map(),
      configOptions: [],
      events: [],
      bufferedBytes: 0,
      lastSeq: 0,
      toolCalls: new Map(),
      sockets: new Set(),
      started: Promise.resolve(),
      connection: (launch.agent?.adapter === 'pi-rpc' ? connectPi : connectAdapter)(
        {
          command,
          env: adapterEnvironmentOf(launch.secrets),
          cwd,
        },
        {
          onUpdate: (params) => onUpdate(conversation, (params.update ?? {}) as Json),
          onRequest: (request) => onRequest(conversation, request),
          onCancelRequest: (requestId) => closeQuestions(conversation, 'cancelled', requestId),
          onExit: (code) => {
            if (conversations.get(id) === conversation)
              fail(conversation, new AcpError(`The adapter exited with code ${code}`))
          },
        },
      ),
    }
    conversations.set(id, conversation)
    conversation.started = start(conversation, launch).catch((error) => {
      fail(conversation, error)
      conversation.connection.close()
    })
    await conversation.started
    if (hasSetup && conversation.status !== 'error') void setUp(conversation)
    return Response.json({ id, ...summaryOf(conversation) }, { status: 201 })
  }

  const summaryOf = (conversation: Conversation) => ({
    execution_status: conversation.status,
    acp_session_id: conversation.sessionId,
    error: conversation.failure,
  })

  const prompt = (
    conversation: Conversation,
    body: { content?: { type?: string; text?: string }[] },
    traceHeaders: Record<string, unknown>,
  ) => {
    if (!conversation.sessionId || conversation.status === 'error')
      return Response.json({ error: 'The conversation has no running session' }, { status: 409 })
    const { sessionId } = conversation
    conversation.status = 'running'
    conversation.keptPlanning = false
    const startedAt = performance.now()
    const turnEnded = (stopReason: unknown) =>
      log.info({
        event: 'agent.turn',
        body: 'Agent turn ended',
        attributes: {
          'conversation.id': conversation.id,
          'agent.stop_reason': String(stopReason),
          duration_ms: Math.round(performance.now() - startedAt),
        },
      })
    void withSpan(
      'agent.turn',
      { 'conversation.id': conversation.id },
      () =>
        conversation.connection
          .request('session/prompt', {
            sessionId,
            prompt: (body.content ?? [])
              .filter((block) => block.type === 'text')
              .map(({ text }) => ({ type: 'text', text })),
          })
          .then(
            (result) => {
              turnEnded(result.stopReason)
              conversation.status = 'finished'
              closeQuestions(conversation, 'turn_end')
              emit(conversation, {
                sessionUpdate: 'turn_end',
                stopReason: result.stopReason,
                ...(result.stopReason === 'cancelled' && conversation.keptPlanning && { keptPlanning: true }),
              })
              void reportWorkspace(conversation)
            },
            (error) => {
              log.warn({
                event: 'agent.turn',
                body: 'Agent turn failed',
                attributes: {
                  'conversation.id': conversation.id,
                  duration_ms: Math.round(performance.now() - startedAt),
                },
                error,
              })
              if (conversation.status !== 'error') {
                conversation.status = 'finished'
                emit(conversation, errorUpdateOf(error))
              }
              closeQuestions(conversation, 'turn_end')
              emit(conversation, { sessionUpdate: 'turn_end', stopReason: 'error' })
              void reportWorkspace(conversation)
            },
          ),
      contextOf(traceHeaders),
    )
    return Response.json({})
  }

  const remove = (conversation: Conversation) => {
    conversations.delete(conversation.id)
    conversation.connection.close()
    for (const socket of conversation.sockets) socket.close()
    return Response.json({})
  }

  const route = async (method: string, { pathname, searchParams }: URL, request: Request) => {
    if (method === 'POST' && pathname === '/api/conversations') return create(await request.json())
    const [, read] = workspaceRoute.exec(pathname) ?? []
    if (read && method === 'GET') return readWorkspace(read, searchParams)
    const [, workspaceAction] = workspaceActionRoute.exec(pathname) ?? []
    if (method === 'POST' && workspaceAction) {
      const acted = await workspaceActions[workspaceAction as keyof typeof workspaceActions](
        workspaceDirectory,
        await request.json(),
        adapterEnvironmentOf({}),
      )
      return 'failure' in acted ? Response.json({ error: acted.failure }, { status: 422 }) : Response.json(acted)
    }
    const [, conversationId = '', action, questionId] = conversationRoute.exec(pathname) ?? []
    const conversation = conversations.get(conversationId)
    if (!conversation) return Response.json({ error: 'Not found' }, { status: 404 })
    if (questionId && method === 'POST') {
      const pending = conversation.questions.get(questionId)
      if (!pending) return Response.json({ error: 'The question is closed' }, { status: 409 })
      return answer(conversation, pending, await request.json())
        ? Response.json({})
        : Response.json({ error: 'The answer does not fit the question' }, { status: 400 })
    }
    if (questionId) return Response.json({ error: 'Not found' }, { status: 404 })
    if (method === 'GET' && !action) return Response.json({ id: conversation.id, ...summaryOf(conversation) })
    if (method === 'DELETE' && !action) return remove(conversation)
    if (method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 })
    await conversation.started
    if (action === 'events')
      return prompt(conversation, await request.json(), {
        traceparent: request.headers.get('traceparent'),
        tracestate: request.headers.get('tracestate'),
      })
    if (action === 'interrupt') {
      if (conversation.sessionId)
        conversation.connection.notify('session/cancel', { sessionId: conversation.sessionId })
      closeQuestions(conversation, 'stopped')
      return Response.json({})
    }
    if (action === 'switch_acp_model') {
      const { model, thoughtLevel } = (await request.json()) as { model?: string; thoughtLevel?: string }
      await switchModel(conversation, model, thoughtLevel)
      return Response.json({})
    }
    if (action === 'plan_mode') {
      const { enabled } = (await request.json()) as { enabled?: unknown }
      if (typeof enabled !== 'boolean') return Response.json({ error: 'enabled must be a boolean' }, { status: 400 })
      return (await setPlanMode(conversation, enabled))
        ? Response.json({})
        : Response.json({ error: 'The agent has no plan mode' }, { status: 409 })
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
      if (!isApiKey(request.headers.get('x-session-api-key')))
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      return route(request.method, new URL(request.url), request).catch((error) =>
        Response.json({ error: errorUpdateOf(error).message }, { status: 502 }),
      )
    },
    websocket: {
      data: {} as SocketData,
      closeOnBackpressureLimit: true,
      open: (socket) =>
        void setTimeout(() => {
          if (!socket.data.isAuthenticated) socket.close(1008, 'Unauthorized')
        }, authTimeoutMilliseconds),
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
        if (!conversation || auth?.type !== 'auth' || !isApiKey(auth.session_api_key))
          return void socket.close(1008, 'Unauthorized')
        socket.data.isAuthenticated = true
        const { workspace } = conversation
        if (workspace && workspace.seq <= socket.data.after) socket.send(JSON.stringify(workspace))
        for (const event of conversation.events) if (event.seq > socket.data.after) socket.send(event.frame)
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
