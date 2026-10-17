import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type HostFrame = {
  type: string
  id?: number
  sid?: number
  op?: string
  args?: Record<string, string>
  runtimeId?: string
  method?: string
  path?: string
  headers?: Record<string, string>
  body?: string
  data?: string
  status?: number
}
export type Launch = {
  agent: { acp_command: string[]; acp_model?: string; acp_thought_level?: string; acp_resume_session_id?: string }
  secrets: Record<string, { value: string }>
  parent_conversation_id?: string
}
export type FakeContainer = { running: boolean; apiKey: string; isBooted?: boolean }
export type ContainerAgent = {
  respond(request: Required<Pick<HostFrame, 'method' | 'path'>> & HostFrame, container: FakeContainer): unknown
  connect(stream: { path: string; container: FakeContainer; send(data: string): void; close(): void }): {
    onMessage(data: string): void
    onClose(): void
  }
  stopped?(container: FakeContainer): void
}
export type ModelCall = (request: {
  path?: string
  headers?: Record<string, string>
  body?: string
  onChunk?: (data: string) => void
  onHead?: (status: number | undefined) => void
  signal?: AbortSignal
  timeoutMilliseconds?: number
}) => Promise<{ status: number | undefined; body: string; ended: string | undefined }>

type Agent = { port: number; process: Bun.Subprocess<'ignore', 'pipe', 'inherit'> }

const repositoryRoot = new URL('../../../../', import.meta.url).pathname
const listening = /hq-agent listening on port (\d+)/
const modelCallMilliseconds = 300_000
const runningAgents = new Set<Bun.Subprocess>()
export const stopAllHqAgents = () => {
  for (const agent of runningAgents) agent.kill()
}

const serveGateway = (modelCall: () => ModelCall) =>
  Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: (request) => {
      const { pathname, search } = new URL(request.url)
      const encoder = new TextEncoder()
      const head = Promise.withResolvers<number | undefined>()
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) =>
          void request.text().then((body) =>
            modelCall()({
              path: `${pathname}${search}`,
              headers: Object.fromEntries(request.headers),
              body,
              signal: request.signal,
              timeoutMilliseconds: modelCallMilliseconds,
              onHead: head.resolve,
              onChunk: (data) => request.signal.aborted || controller.enqueue(encoder.encode(data)),
            }).then(({ status }) => {
              head.resolve(status)
              if (!request.signal.aborted) controller.close()
            }),
          ),
      })
      return head.promise.then((status) => new Response(stream, { status: status ?? 502 }))
    },
  })

export const createHqAgentRelay = ({
  gapMilliseconds = 20,
  startFails = false,
  holdUrl,
  modelCall,
}: {
  gapMilliseconds?: number
  startFails?: boolean
  holdUrl?: string
  modelCall?: () => ModelCall
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'hq-agent-relay-'))
  const shims = join(directory, 'bin')
  const launches = join(directory, 'launches')
  const gateway = modelCall && serveGateway(modelCall)
  mkdirSync(shims)
  mkdirSync(join(directory, '.codex'))
  for (const { command, flavour } of [
    { command: 'claude-agent-acp', flavour: 'claude' },
    { command: 'codex-acp', flavour: 'codex' },
    { command: 'pi', flavour: 'pi' },
  ])
    writeFileSync(
      join(shims, command),
      `#!/bin/sh\necho ${flavour} >> ${launches}\nexec env ${startFails ? 'STUB_FAIL_START=1 ' : ''}${gateway ? `STUB_GATEWAY=http://localhost:${gateway.port} ` : ''}${holdUrl ? `STUB_HOLD_URL='${holdUrl}' ` : ''}STUB_FLAVOUR=${flavour} STUB_STATE=${directory}/sessions STUB_GAP_MS=${gapMilliseconds} node ${repositoryRoot}apps/agent/fixtures/stub-acp-agent.mjs "$@"\n`,
      { mode: 0o755 },
    )
  const agents = new Map<string, Promise<Agent>>()
  const workspaces = new Map<string, string>()
  const workspaceOf = ({ apiKey }: FakeContainer) => {
    const workspace = workspaces.get(apiKey) ?? join(directory, `workspace-${workspaces.size + 1}`)
    mkdirSync(workspace, { recursive: true })
    workspaces.set(apiKey, workspace)
    return workspace
  }
  const upstreams = new Set<WebSocket>()
  const bridgeSends = new Set<(data: string) => void>()
  const created: Record<string, unknown>[] = []
  const prompts: string[] = []
  const modelSwitches: (string | undefined)[] = []
  const thoughtLevels: (string | undefined)[] = []
  const interrupts: string[] = []
  const socketPaths: string[] = []

  let isStopped = false
  const startAgent = async (apiKey: string): Promise<Agent> => {
    if (isStopped) throw new Error('The hq-agent relay was stopped')
    const child = Bun.spawn([process.execPath, `${repositoryRoot}apps/agent/src/main.ts`], {
      env: {
        PATH: `${shims}:${process.env.PATH}`,
        HOME: directory,
        PORT: '0',
        OH_SESSION_API_KEYS_0: apiKey,
      },
      stdout: 'pipe',
      stderr: 'inherit',
    })
    runningAgents.add(child)
    void child.exited.then(() => runningAgents.delete(child))
    const decoder = new TextDecoder()
    const reader = child.stdout.getReader()
    let output = ''
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      output += decoder.decode(chunk.value)
      const port = listening.exec(output)?.[1]
      if (port) return { port: Number(port), process: child }
    }
    throw new Error('hq-agent exited before listening')
  }
  const agentOf = ({ apiKey }: FakeContainer) => {
    const agent = agents.get(apiKey) ?? startAgent(apiKey)
    agents.set(apiKey, agent)
    return agent
  }
  const stopContainer = async ({ apiKey }: FakeContainer) => {
    const agent = await agents.get(apiKey)
    agents.delete(apiKey)
    agent?.process.kill()
  }

  const containerAgent = {
    respond: async ({ method, path, headers, body }, container) => {
      const { port } = await agentOf(container)
      const sent = method === 'POST' ? JSON.parse(body || '{}') : {}
      const launch = method === 'POST' && path === '/api/conversations' ? sent : undefined
      if (launch) created.push(structuredClone(launch))
      if (path.endsWith('/events')) prompts.push(sent.content?.[0]?.text)
      if (path.endsWith('/interrupt')) interrupts.push(path.split('/')[3] ?? '')
      if (path.endsWith('/switch_acp_model')) {
        modelSwitches.push(sent.model)
        thoughtLevels.push(sent.thoughtLevel)
      }
      const response = await fetch(`http://localhost:${port}${path}`, {
        method,
        headers,
        body: launch ? JSON.stringify({ ...launch, workspace: { working_dir: workspaceOf(container) } }) : body,
      })
      return { status: response.status, body: await response.text() }
    },
    connect: ({ path, container, send, close }) => {
      const pending: string[] = []
      let upstream: WebSocket | undefined
      bridgeSends.add(send)
      void agentOf(container).then(({ port }) => {
        socketPaths.push(path)
        upstream = new WebSocket(`ws://localhost:${port}${path}`)
        upstreams.add(upstream)
        upstream.onopen = () => {
          for (const data of pending.splice(0)) upstream?.send(data)
        }
        upstream.onmessage = (message) => send(String(message.data))
        upstream.onclose = () => {
          bridgeSends.delete(send)
          if (upstream) upstreams.delete(upstream)
          close()
        }
      })
      return {
        onMessage: (data) => (upstream?.readyState === WebSocket.OPEN ? upstream.send(data) : pending.push(data)),
        onClose: () => upstream?.close(),
      }
    },
    stopped: (container) => void stopContainer(container),
  } satisfies ContainerAgent
  const stopAgentsExcept = async (apiKeys: readonly string[]) => {
    const stopping = [...agents.entries()].filter(([apiKey]) => !apiKeys.includes(apiKey))
    for (const [apiKey] of stopping) agents.delete(apiKey)
    for (const agent of await Promise.allSettled(stopping.map(([, agent]) => agent)))
      if (agent.status === 'fulfilled') {
        agent.value.process.kill()
        await agent.value.process.exited
      }
  }
  const stopAgents = () => stopAgentsExcept([])

  return {
    containerAgent,
    created,
    prompts,
    modelSwitches,
    thoughtLevels,
    interrupts,
    socketPaths,
    agentCount: () => agents.size,
    adapterLaunches: () => (existsSync(launches) ? readFileSync(launches, 'utf8').trim().split('\n') : []),
    restart: stopAgents,
    stopAgentsExcept,
    forgetSessions: () => rmSync(join(directory, 'sessions'), { recursive: true, force: true }),
    forgeUpdate: (update: object) => {
      const event = { id: crypto.randomUUID(), seq: 0, timestamp: new Date().toISOString(), completed: true, update }
      for (const send of bridgeSends) send(JSON.stringify(event))
    },
    dropSockets: () => {
      for (const upstream of upstreams) upstream.close()
    },
    stop: async () => {
      isStopped = true
      await stopAgents()
      await gateway?.stop(true)
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
