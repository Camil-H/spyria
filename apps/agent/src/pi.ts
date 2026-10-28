import { existsSync } from 'node:fs'
import {
  AcpError,
  type AdapterHandlers,
  type AdapterLaunch,
  type Json,
  liveOutputCharacters,
  methodNotFound,
  spawnJsonLines,
} from './acp.ts'

type PiModel = { provider: string; id: string; name?: string }
type PiEdit = { oldText?: string; newText?: string }

const otherChoice = 'Other…'
const dialogMethods = ['select', 'confirm', 'input', 'editor']
const confirmChoices = { yes: 'Yes', no: 'No' }
const toolKinds: Record<string, string> = { bash: 'execute', read: 'read', edit: 'edit', write: 'edit' }

const textOf = (result: Json) =>
  ((result.content ?? []) as Json[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')

const diffOf = (toolName: string, { path, content, edits, oldText, newText }: Json) => {
  if (toolName === 'write') return { type: 'diff', path, oldText: null, newText: content }
  if (toolName !== 'edit') return undefined
  const parts = (edits ?? [{ oldText, newText }]) as PiEdit[]
  const joined = (side: keyof PiEdit) => parts.map((part) => part[side]).join('\n')
  return { type: 'diff', path, oldText: joined('oldText'), newText: joined('newText') }
}

const toolOutputOf = (toolName: string, result: Json, isError: boolean, input: Json) => {
  const structured = result.structuredContent as { output?: string; exit_code?: number } | undefined
  const diff = !isError && diffOf(toolName, input)
  if (toolName === 'bash')
    return {
      rawOutput: {
        formatted_output: structured?.output ?? textOf(result),
        exit_code: structured?.exit_code ?? Number(isError),
      },
    }
  return diff
    ? { content: [diff] }
    : { content: [{ type: 'content', content: { type: 'text', text: textOf(result) } }], rawOutput: result }
}

export const connectPi = (launch: AdapterLaunch, { onUpdate, onExit, onRequest }: AdapterHandlers) => {
  const pending = new Map<string, PromiseWithResolvers<Json>>()
  const toolInputs = new Map<string, Json>()
  let nextId = 0
  let isAborting = false
  const runningToolCallIds = new Set<string>()
  let freeAnswer: string | undefined
  let providerError: string | undefined
  const update = (fields: Json) => onUpdate({ update: fields })
  const send = (type: string, fields: Json = {}) => {
    if (pi.hasExited) return Promise.reject(new AcpError('The adapter exited'))
    const id = `spyria-${nextId++}`
    const request = Promise.withResolvers<Json>()
    pending.set(id, request)
    pi.write({ id, type, ...fields })
    return request.promise
  }

  const answerDialog = (request: Json) => {
    const { id, method } = request
    const respond = (fields: Json) => pi.write({ type: 'extension_ui_response', id, ...fields })
    if (method === 'input' && freeAnswer !== undefined) {
      respond({ value: freeAnswer })
      freeAnswer = undefined
      return
    }
    const isConfirm = method === 'confirm'
    const choices = isConfirm ? Object.values(confirmChoices) : ((request.options ?? []) as string[])
    const asked = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        toolCallId: [...runningToolCallIds].at(-1),
        message: request.title,
        requestedSchema: {
          properties: {
            answer: {
              type: 'string',
              ...(isConfirm && request.message ? { title: request.title, description: request.message } : {}),
              oneOf: choices
                .filter((choice) => choice !== otherChoice)
                .map((choice) => ({ const: choice, title: choice })),
            },
            ...(!isConfirm && { answer_custom: { type: 'string' } }),
          },
        },
      },
    }
    const responseOf = ({ action, content }: Json) => {
      const { answer, answer_custom: free } = (content ?? {}) as Record<string, string | undefined>
      if (action !== 'accept') return { cancelled: true }
      if (isConfirm) return { confirmed: answer === confirmChoices.yes }
      if (!free) return { value: answer }
      if (method !== 'select' || !choices.includes(otherChoice)) return { value: free }
      freeAnswer = free
      return { value: otherChoice }
    }
    void (onRequest({ id: String(id), ...asked }) ?? Promise.reject()).then(
      (result) => respond(responseOf(result)),
      () => respond({ cancelled: true }),
    )
  }

  let turn: PromiseWithResolvers<Json> | undefined
  let turnsEnded: Promise<unknown> = Promise.resolve()
  const onRecord = (record: Json) => {
    const { type } = record
    if (type === 'response') {
      const request = pending.get(String(record.id))
      pending.delete(String(record.id))
      if (record.success) request?.resolve((record.data ?? {}) as Json)
      else request?.reject(new AcpError(String(record.error ?? 'Pi refused the command')))
      return
    }
    if (type === 'extension_ui_request') {
      if (dialogMethods.includes(String(record.method))) answerDialog(record)
      return
    }
    const event = (record.assistantMessageEvent ?? {}) as Json
    if (type === 'message_update' && (event.type === 'text_delta' || event.type === 'thinking_delta'))
      return update({
        sessionUpdate: event.type === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
        content: { type: 'text', text: event.delta },
      })
    const message = (record.message ?? {}) as Json
    if (type === 'message_end' && message.role === 'assistant')
      providerError =
        message.stopReason === 'error' ? String(message.errorMessage ?? 'The model call failed') : undefined
    const toolCallId = String(record.toolCallId)
    const toolName = String(record.toolName)
    if (type === 'tool_execution_start') {
      const input = (record.args ?? {}) as Json
      toolInputs.set(toolCallId, input)
      runningToolCallIds.add(toolCallId)
      return update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: toolName === 'bash' ? input.command : toolName,
        kind: toolKinds[toolName] ?? 'other',
        status: 'in_progress',
        ...(toolName !== 'bash' && { rawInput: input }),
      })
    }
    if (type === 'tool_execution_update' && toolName === 'bash')
      return update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
        rawOutput: { formatted_output: textOf((record.partialResult ?? {}) as Json).slice(-liveOutputCharacters) },
      })
    if (type === 'tool_execution_end') {
      const input = toolInputs.get(toolCallId) ?? {}
      toolInputs.delete(toolCallId)
      runningToolCallIds.delete(toolCallId)
      return update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: record.isError ? 'failed' : 'completed',
        ...toolOutputOf(toolName, (record.result ?? {}) as Json, Boolean(record.isError), input),
      })
    }
    if (type !== 'agent_settled') return
    const isCancelled = record.aborted || isAborting
    if (providerError && !isCancelled) update({ sessionUpdate: 'error', message: providerError })
    providerError = undefined
    turn?.resolve({ stopReason: isCancelled ? 'cancelled' : 'end_turn' })
  }

  const pi = spawnJsonLines(launch, onRecord, (code) => {
    onExit(code)
    for (const request of [...pending.values(), ...(turn ? [turn] : [])])
      request.reject(new AcpError('The adapter exited'))
    pending.clear()
  })

  const sessionOf = async () => {
    const [state, { models }, { levels }] = await Promise.all([
      send('get_state'),
      send('get_available_models'),
      send('get_available_thinking_levels'),
    ])
    const model = state.model as PiModel | undefined
    return {
      sessionId: state.sessionFile,
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: model && `${model.provider}/${model.id}`,
          options: ((models ?? []) as PiModel[]).map(({ provider, id, name }) => ({
            value: `${provider}/${id}`,
            name: name ?? id,
          })),
        },
        {
          id: 'thought_level',
          name: 'Thinking',
          type: 'select',
          category: 'thought_level',
          currentValue: state.thinkingLevel,
          options: ((levels ?? []) as string[]).map((value) => ({ value, name: value })),
        },
      ],
    }
  }
  const methods: Record<string, (params: Json) => Promise<Json>> = {
    initialize: async () => ({}),
    'session/new': sessionOf,
    'session/resume': async ({ sessionId }) => {
      if (!existsSync(String(sessionId))) throw new AcpError('Resource not found')
      await send('switch_session', { sessionPath: sessionId })
      return sessionOf()
    },
    'session/prompt': ({ prompt }) => {
      const ended = turnsEnded.then(async () => {
        isAborting = false
        turn = Promise.withResolvers()
        const { disposition } = await send('prompt', {
          message: (prompt as Json[]).map((block) => block.text).join('\n'),
        })
        return disposition === 'handled' ? { stopReason: 'end_turn' } : turn.promise
      })
      turnsEnded = ended.catch(() => {})
      return ended
    },
    'session/set_config_option': async ({ configId, value }) => {
      const [provider, ...modelId] = String(value).split('/')
      await (configId === 'model'
        ? send('set_model', { provider, modelId: modelId.join('/') })
        : send('set_thinking_level', { level: value }))
      return sessionOf()
    },
  }
  return {
    request: (method: string, params: Json) =>
      methods[method]?.(params) ?? Promise.reject(new AcpError(`${method} is not supported`, methodNotFound)),
    notify: (method: string) => {
      if (method !== 'session/cancel') return
      isAborting = true
      void send('abort').catch(() => {})
    },
    errorOutput: pi.errorOutput,
    closed: pi.closed,
    close: pi.close,
  }
}
