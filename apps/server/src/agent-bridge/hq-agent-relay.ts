import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FakeAgentServer, FakeContainer, ModelCall } from '../testing.ts'

type Agent = { port: number; process: Bun.Subprocess<'ignore', 'pipe', 'inherit'> }

const repositoryRoot = new URL('../../../../', import.meta.url).pathname
const listening = /hq-agent listening on port (\d+)/
const modelCallMilliseconds = 300_000

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
  modelCall,
}: {
  gapMilliseconds?: number
  startFails?: boolean
  modelCall?: () => ModelCall
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'hq-agent-relay-'))
  const shims = join(directory, 'bin')
  const gateway = modelCall && serveGateway(modelCall)
  mkdirSync(shims)
  mkdirSync(join(directory, '.codex'))
  for (const { command, flavour } of [
    { command: 'claude-agent-acp', flavour: 'claude' },
    { command: 'codex-acp', flavour: 'codex' },
    { command: 'pi-acp', flavour: 'pi' },
  ])
    writeFileSync(
      join(shims, command),
      `#!/bin/sh\nexec env ${startFails ? 'STUB_FAIL_START=1 ' : ''}${gateway ? `STUB_GATEWAY=http://localhost:${gateway.port} ` : ''}STUB_FLAVOUR=${flavour} STUB_STATE=${directory}/sessions STUB_GAP_MS=${gapMilliseconds} node ${repositoryRoot}apps/agent/fixtures/stub-acp-agent.mjs "$@"\n`,
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
  const created: Record<string, unknown>[] = []
  const prompts: string[] = []
  const modelSwitches: string[] = []
  const thoughtLevels: (string | undefined)[] = []
  const socketPaths: string[] = []

  const startAgent = async (apiKey: string): Promise<Agent> => {
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

  const agentServer = {
    respond: async ({ method, path, headers, body }, container) => {
      const { port } = await agentOf(container)
      const sent = method === 'POST' ? JSON.parse(body || '{}') : {}
      const launch = method === 'POST' && path === '/api/conversations' ? sent : undefined
      if (launch) created.push(structuredClone(launch))
      if (path.endsWith('/events')) prompts.push(sent.content?.[0]?.text)
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
      void agentOf(container).then(({ port }) => {
        socketPaths.push(path)
        upstream = new WebSocket(`ws://localhost:${port}${path}`)
        upstreams.add(upstream)
        upstream.onopen = () => {
          for (const data of pending.splice(0)) upstream?.send(data)
        }
        upstream.onmessage = (message) => send(String(message.data))
        upstream.onclose = () => {
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
  } satisfies FakeAgentServer
  const stopAgents = async () => {
    for (const agent of await Promise.all(agents.values())) agent.process.kill()
    agents.clear()
  }

  return {
    agentServer,
    created,
    prompts,
    modelSwitches,
    thoughtLevels,
    socketPaths,
    agentCount: () => agents.size,
    restart: stopAgents,
    forgetSessions: () => rmSync(join(directory, 'sessions'), { recursive: true, force: true }),
    dropSockets: () => {
      for (const upstream of upstreams) upstream.close()
    },
    stop: async () => {
      await stopAgents()
      await gateway?.stop(true)
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
