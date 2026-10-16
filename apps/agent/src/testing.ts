import { afterAll, afterEach, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAgent } from './agent.ts'

export type AgentEvent = { id: string; seq: number; completed: boolean; update: Record<string, unknown> }

export const apiKey = 'session-key-0123456789abcdef'
const stub = new URL('../fixtures/stub-acp-agent.mjs', import.meta.url).pathname

export const clientOf = (port: number) => {
  const call = async (method: string, path: string, body?: object, key = apiKey) => {
    const response = await fetch(`http://localhost:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-session-api-key': key },
      body: body && JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  const open = (conversationId: string, after?: number, key = apiKey) => {
    const events: AgentEvent[] = []
    const socket = new WebSocket(
      `ws://localhost:${port}/sockets/events/${conversationId}${after === undefined ? '' : `?after=${after}`}`,
    )
    const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)))
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', session_api_key: key })))
    socket.addEventListener('message', (message) => events.push(JSON.parse(String(message.data))))
    const until = async (isDone: (event: AgentEvent) => boolean, count = 1) => {
      for (const deadline = Date.now() + 10_000; Date.now() < deadline; await Bun.sleep(5))
        if (events.filter(isDone).length >= count) return events
      throw new Error(`Timed out; events: ${JSON.stringify(events.map(({ update }) => update.sessionUpdate))}`)
    }
    return { events, until, closed, close: () => socket.close() }
  }
  const create = async (launch: object) => {
    const { status, body } = await call('POST', '/api/conversations', launch)
    expect(status).toBe(201)
    return String(body.id)
  }
  const prompt = (conversationId: string, text: string) =>
    call('POST', `/api/conversations/${conversationId}/events`, {
      role: 'user',
      content: [{ type: 'text', text }],
      run: true,
    })
  return { call, open, create, prompt }
}

export const kindOf = (kind: string) => (event: AgentEvent) => event.update.sessionUpdate === kind
export const textOf = (events: AgentEvent[]) =>
  events
    .filter(kindOf('agent_message_chunk'))
    .map(({ update }) => (update.content as { text: string }).text)
    .join('')
export const piHello = (turn: number, mode = 'default') =>
  `[t${turn}] Hello from the stub (model stub/stub-default, mode ${mode}).`
export const questionAt = async (socket: ReturnType<ReturnType<typeof clientOf>['open']>, count: number) =>
  String((await socket.until(kindOf('question'), count)).filter(kindOf('question'))[count - 1]?.update.questionId)

export const createAgentTestbed = () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), 'hq-agent-test-'))
  const stubCommand = ['env', `STUB_STATE=${stateDirectory}`, 'STUB_GAP_MS=5', 'node', stub]
  const launchOf = (extra: Record<string, unknown> = {}, secrets = {}) => ({
    agent: { kind: 'ACPAgent', acp_command: stubCommand, ...extra },
    secrets,
    workspace: { kind: 'LocalWorkspace', working_dir: stateDirectory },
  })
  const piLaunchOf = (extra: Record<string, unknown> = {}) =>
    launchOf({ acp_command: ['env', 'STUB_FLAVOUR=pi', ...stubCommand.slice(1)], adapter: 'pi-rpc', ...extra })
  const running: { stop: () => void }[] = []
  afterEach(() => {
    for (const agent of running.splice(0)) agent.stop()
  })
  afterAll(() => rmSync(stateDirectory, { recursive: true, force: true }))
  const started = (options: Partial<Parameters<typeof startAgent>[0]> = {}) => {
    const agent = startAgent({ apiKey, port: 0, ...options })
    running.push(agent)
    return { agent, ...clientOf(agent.port) }
  }
  return { stateDirectory, stubCommand, launchOf, piLaunchOf, running, started }
}
