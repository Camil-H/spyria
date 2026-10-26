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
  error?: { code?: number; message?: string; data?: unknown }
}

export class AcpError extends Error {
  code?: number
  details?: string
  constructor(message: string, code?: number, details?: string) {
    super(message)
    this.code = code
    this.details = details
  }
}

export const methodNotFound = -32601
export const internalError = -32603
export const liveOutputCharacters = 4_000
export const keptErrorOutputLines = 50
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
  const child = spawn(program, programArguments, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const errorOutput: string[] = []
  const closed = Promise.withResolvers<void>()
  const lines = {
    hasExited: false,
    write: (record: Json) => {
      if (!lines.hasExited) child.stdin.write(`${JSON.stringify(record)}\n`)
    },
    errorOutput: () => [...errorOutput],
    closed: closed.promise,
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
  child.on('close', () => closed.resolve())
  const decoder = new TextDecoder()
  const readLines = lineReaderOf((line) => {
    let record: Json
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    onRecord(record)
  })
  child.stdout.on('data', (chunk: Buffer) => readLines(decoder.decode(chunk, { stream: true })))
  const errorDecoder = new TextDecoder()
  const readErrorLines = lineReaderOf((line) => {
    errorOutput.push(line)
    if (errorOutput.length > keptErrorOutputLines) errorOutput.shift()
  })
  child.stderr.on('data', (chunk: Buffer) => readErrorLines(errorDecoder.decode(chunk, { stream: true })))
  return lines
}

export const lineReaderOf = (onLine: (line: string) => void) => {
  let partialPieces: string[] = []
  return (text: string) => {
    let lineStart = 0
    for (let lineEnd = text.indexOf('\n'); lineEnd !== -1; lineEnd = text.indexOf('\n', lineStart)) {
      partialPieces.push(text.slice(lineStart, lineEnd))
      const line = partialPieces.join('')
      partialPieces = []
      lineStart = lineEnd + 1
      onLine(line)
    }
    if (lineStart < text.length) partialPieces.push(text.slice(lineStart))
  }
}

const detailsOf = (data: unknown) => {
  const details = typeof data === 'object' && data !== null ? (data as Json).details : data
  return typeof details === 'string' ? details : undefined
}

const acpErrorOf = ({ message, code, data }: NonNullable<Frame['error']>) =>
  new AcpError(message ?? 'The adapter failed', code, detailsOf(data))

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
      if (frame.error) request?.reject(acpErrorOf(frame.error))
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
    errorOutput: adapter.errorOutput,
    closed: adapter.closed,
    close: adapter.close,
  }
}

export type AdapterConnection = ReturnType<typeof connectAdapter>
