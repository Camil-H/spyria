import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export type Json = Record<string, unknown>
export type AdapterLaunch = { command: string[]; env: Record<string, string>; cwd: string }
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
const permissionPreference = ['allow_always', 'allow_once']

const permissionAnswerOf = (params: Json | undefined) => {
  const options = (params?.options ?? []) as { optionId: string; kind?: string }[]
  const allowed =
    permissionPreference.map((kind) => options.find((option) => option.kind === kind)).find(Boolean) ?? options[0]
  return { outcome: allowed ? { outcome: 'selected', optionId: allowed.optionId } : { outcome: 'cancelled' } }
}

export const connectAdapter = (
  { command, env, cwd }: AdapterLaunch,
  { onUpdate, onExit }: { onUpdate: (params: Json) => void; onExit: (code: number | null) => void },
) => {
  const [program = '', ...programArguments] = command
  const child = spawn(program, programArguments, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] })
  const pending = new Map<number, PromiseWithResolvers<Json>>()
  let nextId = 0
  let exited = false
  const write = (frame: Frame) => {
    if (!exited) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)
  }
  const exit = (code: number | null) => {
    if (exited) return
    exited = true
    onExit(code)
    for (const request of pending.values()) request.reject(new AcpError('The adapter exited'))
    pending.clear()
  }
  child.stdin.on('error', () => {})
  child.on('error', () => exit(null))
  child.on('exit', (code) => exit(code))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let frame: Frame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (frame.method === undefined) {
      const request = pending.get(Number(frame.id))
      pending.delete(Number(frame.id))
      if (frame.error) request?.reject(new AcpError(frame.error.message ?? 'The adapter failed', frame.error.code))
      else request?.resolve(frame.result ?? {})
    } else if (frame.id !== undefined)
      write(
        frame.method === 'session/request_permission'
          ? { id: frame.id, result: permissionAnswerOf(frame.params) }
          : { id: frame.id, error: { code: methodNotFound, message: `${frame.method} is not supported` } },
      )
    else if (frame.method === 'session/update' && frame.params) onUpdate(frame.params)
  })
  return {
    request: (method: string, params: Json) => {
      if (exited) return Promise.reject(new AcpError('The adapter exited'))
      const id = nextId++
      const request = Promise.withResolvers<Json>()
      pending.set(id, request)
      write({ id, method, params })
      return request.promise
    },
    notify: (method: string, params: Json) => write({ method, params }),
    close: () => child.kill(),
  }
}

export type AdapterConnection = ReturnType<typeof connectAdapter>
