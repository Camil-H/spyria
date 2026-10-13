import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FakeAgentServer, FakeContainer } from '../testing.ts'

type Agent = { port: number; process: Bun.Subprocess<'ignore', 'pipe', 'inherit'> }

const repositoryRoot = new URL('../../../../', import.meta.url).pathname
const listening = /hq-agent listening on port (\d+)/

export const createHqAgentRelay = ({
  gapMilliseconds = 20,
  startFails = false,
}: {
  gapMilliseconds?: number
  startFails?: boolean
} = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'hq-agent-relay-'))
  const shims = join(directory, 'bin')
  const workspace = join(directory, 'workspace')
  mkdirSync(shims)
  mkdirSync(workspace)
  mkdirSync(join(directory, '.codex'))
  for (const { command, flavour } of [
    { command: 'claude-agent-acp', flavour: 'claude' },
    { command: 'codex-acp', flavour: 'codex' },
  ])
    writeFileSync(
      join(shims, command),
      `#!/bin/sh\nexec env ${startFails ? 'STUB_FAIL_START=1 ' : ''}STUB_FLAVOUR=${flavour} STUB_STATE=${directory}/sessions STUB_GAP_MS=${gapMilliseconds} node ${repositoryRoot}apps/agent/fixtures/stub-acp-agent.mjs "$@"\n`,
      { mode: 0o755 },
    )
  const agents = new Map<string, Promise<Agent>>()
  const upstreams = new Set<WebSocket>()
  const created: Record<string, unknown>[] = []
  const prompts: string[] = []
  const modelSwitches: string[] = []
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
      if (path.endsWith('/switch_acp_model')) modelSwitches.push(sent.model)
      const response = await fetch(`http://localhost:${port}${path}`, {
        method,
        headers,
        body: launch ? JSON.stringify({ ...launch, workspace: { working_dir: workspace } }) : body,
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

  return {
    agentServer,
    created,
    prompts,
    modelSwitches,
    socketPaths,
    dropSockets: () => {
      for (const upstream of upstreams) upstream.close()
    },
    stop: async () => {
      for (const agent of await Promise.all(agents.values())) agent.process.kill()
      agents.clear()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
