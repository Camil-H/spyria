import { spawn } from 'node:child_process'

export type Json = Record<string, unknown>
export type AdapterLaunch = { command: string[]; env: Record<string, string>; cwd: string }
export type AdapterRequest = { id: number | string; method: string; params: Json }
export type AdapterHandlers = {
  onUpdate: (params: Json) => void
  onExit: (code: number | null) => void
  onRequest: (request: AdapterRequest) => Promise<Json> | undefined
  onCancelRequest: (requestId: number | string) => void
}
type Frame = {
  id?: number | string
  method?: string
  params?: Json
  result?: Json
  error?: { code?: number; message?: string }
}

export class AcpError extends Error {
  code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.code = code
  }
}

export const methodNotFound = -32601
export const liveOutputCharacters = 4_000
const permissionPreference = ['allow_always', 'allow_once']

const permissionAnswerOf = (params: Json | undefined) => {
  const options = (params?.options ?? []) as { optionId: string; kind?: string }[]
  const allowed =
    permissionPreference.map((kind) => options.find((option) => option.kind === kind)).find(Boolean) ?? options[0]
  return { outcome: allowed ? { outcome: 'selected', optionId: allowed.optionId } : { outcome: 'cancelled' } }
}

export const spawnJsonLines = (
  { command, env, cwd }: AdapterLaunch,
  onRecord: (record: Json) => void,
  onExit: (code: number | null) => void,
) => {
  const [program = '', ...programArguments] = command
  const child = spawn(program, programArguments, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = {
    hasExited: false,
    write: (record: Json) => {
      if (!lines.hasExited) child.stdin.write(`${JSON.stringify(record)}\n`)
    },
    close: () => child.kill(),
  }
  const exit = (code: number | null) => {
    if (lines.hasExited) return
    lines.hasExited = true
    onExit(code)
  }
  child.stdin.on('error', () => {})
  child.on('error', () => exit(null))
  child.on('exit', (code) => exit(code))
  const decoder = new TextDecoder()
  let buffered = ''
  child.stdout.on('data', (chunk: Buffer) => {
    const parts = (buffered + decoder.decode(chunk, { stream: true })).split('\n')
    buffered = parts.pop() ?? ''
    for (const line of parts) {
      let record: Json
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      onRecord(record)
    }
  })
  return lines
}

export const connectAdapter = (
  launch: AdapterLaunch,
  { onUpdate, onExit, onRequest, onCancelRequest }: AdapterHandlers,
) => {
  const pending = new Map<number, PromiseWithResolvers<Json>>()
  let nextId = 0
  const onFrame = (frame: Frame) => {
    if (frame.method === undefined) {
      const request = pending.get(Number(frame.id))
      pending.delete(Number(frame.id))
      if (frame.error) request?.reject(new AcpError(frame.error.message ?? 'The adapter failed', frame.error.code))
      else request?.resolve(frame.result ?? {})
    } else if (frame.id !== undefined) {
      const { id, method } = frame
      const answer =
        onRequest({ id, method, params: frame.params ?? {} }) ??
        (method === 'session/request_permission' ? Promise.resolve(permissionAnswerOf(frame.params)) : undefined)
      if (!answer)
        adapter.write({ jsonrpc: '2.0', id, error: { code: methodNotFound, message: `${method} is not supported` } })
      else
        answer.then(
          (result) => adapter.write({ jsonrpc: '2.0', id, result }),
          (error) =>
            adapter.write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(error?.message ?? error) } }),
        )
    } else if (frame.method === '$/cancel_request' && frame.params?.requestId !== undefined)
      onCancelRequest(frame.params.requestId as number | string)
    else if (frame.method === 'session/update' && frame.params) onUpdate(frame.params)
  }
  const adapter = spawnJsonLines(launch, onFrame, (code) => {
    onExit(code)
    for (const request of pending.values()) request.reject(new AcpError('The adapter exited'))
    pending.clear()
  })
  return {
    request: (method: string, params: Json) => {
      if (adapter.hasExited) return Promise.reject(new AcpError('The adapter exited'))
      const id = nextId++
      const request = Promise.withResolvers<Json>()
      pending.set(id, request)
      adapter.write({ jsonrpc: '2.0', id, method, params })
      return request.promise
    },
    notify: (method: string, params: Json) => adapter.write({ jsonrpc: '2.0', method, params }),
    close: adapter.close,
  }
}

export type AdapterConnection = ReturnType<typeof connectAdapter>
