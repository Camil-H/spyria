import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Database, events, resetDatabase } from '@hq/db/postgres'
import {
  createTestDatabase,
  prepareSeededGatewayKeys,
  startTestGateway,
  startZeroCache,
  testGatewayAdmin,
} from '@hq/db/testing'
import { memberId, workspaceId } from '@hq/kernel'
import { createLlmGateway } from '@hq/profile/server'
import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'
import { createFakeLlm, type FakeLlmScript } from './fake-llm.ts'

export const testAuthSettings = {
  tokenSecret: 'integration-test-secret',
  appOrigin: 'http://localhost:5190',
  oidc: { issuer: 'http://localhost:5556/dex', clientId: 'hq', redirectUri: 'http://localhost:3100/auth/callback' },
}

export const acme = workspaceId('workspace-acme')
export const globex = workspaceId('workspace-globex')
export const alice = memberId('member-alice')
export const bob = memberId('member-bob')
export const aliceInAcme = { workspaceId: acme, userId: alice }
export const bobInAcme = { workspaceId: acme, userId: bob }
export const succeeded = {}
export const failedWith = (message: string) => ({ error: 'app', message })

export const issueTestSession = async (
  database: Database,
  workspaceId: string,
  userId: string,
  databaseName?: string,
) => {
  const [session] = await openSessions(database, userId, workspaceId)
  if (!session) throw new Error(`${userId} is not a member of ${workspaceId}`)
  const issued = await issueSessionToken(testAuthSettings.tokenSecret, session, { databaseName })
  return { ...issued, sessionId: session.sessionId }
}

export const sessionTokenOf = async (database: Database, workspaceId: string, userId: string) =>
  (await issueTestSession(database, workspaceId, userId)).token

export const waitFor = async (isDone: () => boolean | Promise<boolean>, timeoutMilliseconds = 10_000) => {
  for (const deadline = Date.now() + timeoutMilliseconds; !(await isDone()); await sleep(10))
    if (Date.now() > deadline) throw new Error(`The condition was not met within ${timeoutMilliseconds / 1000} s`)
}

const sharedAppId = 'hqtest'

export const requestMutation = async (
  app: { request: (path: string, init: RequestInit) => Response | Promise<Response> },
  database: Database,
  { workspaceId, userId }: { workspaceId: string; userId: string },
  name: string,
  args: Record<string, unknown>,
) => {
  const response = await app.request(`/api/mutate?schema=${sharedAppId}_0&appID=${sharedAppId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await sessionTokenOf(database, workspaceId, userId)}` },
    body: JSON.stringify({
      clientGroupID: crypto.randomUUID(),
      mutations: [{ type: 'custom', id: 1, clientID: crypto.randomUUID(), name, args: [args], timestamp: Date.now() }],
      pushVersion: 1,
      timestamp: Date.now(),
      requestID: crypto.randomUUID(),
    }),
  })
  return ((await response.json()) as { mutations: { result: unknown }[] }).mutations[0]?.result
}

const integrationGatewayPort = 4880
export const llmGatewayAt = (url: string) =>
  createLlmGateway({ url, adminUser: testGatewayAdmin.user, adminPassword: testGatewayAdmin.password })

const startSharedTestApp = async () => {
  const testDatabase = await createTestDatabase()
  const { database } = testDatabase
  const fakeLlmCalls: Record<string, string>[] = []
  let fakeLlmScript: FakeLlmScript | undefined
  const fakeLlm = new Hono()
    .use(async (context, next) => {
      fakeLlmCalls.push(Object.fromEntries(context.req.raw.headers))
      await next()
    })
    .route(
      '/',
      createFakeLlm(() => fakeLlmScript),
    )
  const llmGateway = llmGatewayAt(`http://127.0.0.1:${integrationGatewayPort}`)
  const app = createApp({ database, ...testAuthSettings, llmGateway, fakeLlm })
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
  const stopServerAndDatabase = async () => {
    void server.stop(true)
    await testDatabase.drop()
  }
  const [zeroCache, gateway] = await Promise.allSettled([
    startZeroCache({ databaseName: testDatabase.name, port: 4890, appId: sharedAppId, serverUrl: server.url.origin }),
    startTestGateway({
      name: 'integration',
      port: integrationGatewayPort,
      fakeLlmUrl: `http://host.docker.internal:${server.port}/fake-llm`,
    }),
  ])
  if (zeroCache.status === 'rejected' || gateway.status === 'rejected') {
    if (zeroCache.status === 'fulfilled') await zeroCache.value.stop()
    if (gateway.status === 'fulfilled') await gateway.value.stop()
    await stopServerAndDatabase()
    throw zeroCache.status === 'rejected' ? zeroCache.reason : (gateway as PromiseRejectedResult).reason
  }
  const resultOf = (member: { workspaceId: string; userId: string }, name: string, args: Record<string, unknown>) =>
    requestMutation(app, database, member, name, args)
  const eventsOf = async (chatId: string) =>
    (await database.select().from(events))
      .filter((event) => event.chatId === chatId)
      .toSorted((first, second) => first.seq - second.seq)
  const changesOf = async (chatId: string) =>
    (await eventsOf(chatId)).map(({ seq, type, actor, payload }) => ({ seq, type, actor, payload }))
  return {
    database,
    app,
    port: Number(server.port),
    zeroCacheUrl: zeroCache.value.url,
    gateway: gateway.value,
    llmGateway,
    seededGatewayKeys: () => prepareSeededGatewayKeys(gateway.value),
    fakeLlmCalls,
    setFakeLlmScript: (script: FakeLlmScript | undefined) => {
      fakeLlmScript = script
    },
    resultOf,
    eventsOf,
    changesOf,
    stop: async () => {
      await Promise.all([zeroCache.value.stop(), gateway.value.stop()])
      await stopServerAndDatabase()
    },
  }
}

let sharedTestApp: ReturnType<typeof startSharedTestApp> | undefined

export const openSharedTestApp = async () => {
  sharedTestApp ??= startSharedTestApp()
  const testApp = await sharedTestApp
  await resetDatabase(testApp.database, await testApp.seededGatewayKeys())
  return testApp
}

export const stopSharedTestApp = async () => (await sharedTestApp)?.stop()

type HostFrame = {
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
export const fakeHostGatewayUrl = 'http://fake-gateway-relay.test:4000/v1'
type HostCommand = { op: string; runtimeId?: string; image?: string; apiKey?: string }
export type FakeContainer = { running: boolean; apiKey: string; readyAt?: number }
export type FakeAgentServer = {
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
  signal?: AbortSignal
  timeoutMilliseconds?: number
}) => Promise<{ status: number | undefined; body: string; ended: string | undefined }>
export type FakeHost = Awaited<ReturnType<ReturnType<typeof createFakeHosts>['fakeHost']>>
const gibibyte = 1024 ** 3
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export const createFakeHosts = ({ port, database }: { port: number; database: Database }) => {
  const connectedHosts = new Set<FakeHost>()
  const hostStatus = async (hostId: string) =>
    (await database.$client`select status from runtime_hosts where id = ${hostId}`)[0]?.status
  const fakeHost = async (
    name: string,
    {
      memoryGibibytes = 8,
      agentServer,
      bootMilliseconds = 0,
    }: { memoryGibibytes?: number; agentServer?: FakeAgentServer; bootMilliseconds?: number } = {},
  ) => {
    const id = crypto.randomUUID()
    const token = sha256(id)
    await database.$client`
      insert into runtime_hosts (workspace_id, id, name, token_hash, status, running_runtimes, created_by, created_at)
      values (${acme}, ${id}, ${name}, ${sha256(token)}, 'offline', 0, ${alice}, now())`
    const containers = new Map<string, FakeContainer>()
    const commands: HostCommand[] = []
    const heldReplies = new Map<string, Promise<void>>()
    const failingOps = new Set<string>()
    const streams = new Map<number, ReturnType<FakeAgentServer['connect']>>()
    const modelCalls = new Map<number, { frames: HostFrame[]; done: () => void; onChunk?: (data: string) => void }>()
    const receivedFrames: string[] = []
    let nextModelCallId = 1
    const run = (op: string, { runtimeId = '', apiKey = '' }: Record<string, string>) => {
      if (failingOps.has(op)) throw new Error(`${op} failed`)
      const container = containers.get(runtimeId)
      if (op === 'create') containers.set(runtimeId, { running: false, apiKey })
      if (op === 'start' && container)
        Object.assign(container, { running: true, readyAt: Date.now() + bootMilliseconds })
      if ((op === 'stop' || op === 'remove') && container) {
        container.running = false
        agentServer?.stopped?.(container)
      }
      if (op === 'remove') containers.delete(runtimeId)
      if (op === 'status') return container ? (container.running ? 'running' : 'stopped') : 'missing'
      return null
    }
    let socket: WebSocket | undefined
    let closed = Promise.resolve()
    const host = {
      id,
      containers,
      commands,
      failing: (op: string) => failingOps.add(op),
      hold: (op: string) => {
        const { promise, resolve } = Promise.withResolvers<void>()
        heldReplies.set(op, promise)
        return resolve
      },
      receivedFrames,
      modelCall: (async ({
        path = '/v1/chat/completions',
        headers = {},
        body = '',
        onChunk,
        signal,
        timeoutMilliseconds = 20_000,
      }) => {
        const sid = nextModelCallId++
        const { promise, resolve } = Promise.withResolvers<void>()
        const frames: HostFrame[] = []
        const cancel = () => {
          socket?.send(JSON.stringify({ type: 'gw_cancel', sid }))
          resolve()
        }
        signal?.addEventListener('abort', cancel)
        modelCalls.set(sid, { frames, done: resolve, onChunk })
        socket?.send(JSON.stringify({ type: 'gw_req', sid, method: 'POST', path, headers, body }))
        await Promise.race([promise, Bun.sleep(timeoutMilliseconds)])
        signal?.removeEventListener('abort', cancel)
        modelCalls.delete(sid)
        const head = frames.find((frame) => frame.type === 'gw_head')
        return {
          status: head?.status,
          body: frames.map((frame) => frame.data ?? '').join(''),
          ended: frames.at(-1)?.type,
        }
      }) satisfies ModelCall,
      lifecycleCommands: () =>
        commands.filter(({ op }) => ['create', 'start', 'stop', 'remove'].includes(op)).map(({ op }) => op),
      closed: () => closed,
      connect: async () => {
        const opened = new WebSocket(`ws://localhost:${port}/host`)
        socket = opened
        closed = new Promise((resolve) => opened.addEventListener('close', () => resolve()))
        const send = (frame: object) => opened.send(JSON.stringify(frame))
        opened.onmessage = (message) => {
          receivedFrames.push(String(message.data))
          const frame = JSON.parse(String(message.data)) as HostFrame
          const modelCall = modelCalls.get(frame.sid ?? 0)
          if (modelCall && frame.type.startsWith('gw_')) {
            modelCall.frames.push(frame)
            if (frame.type === 'gw_chunk') modelCall.onChunk?.(frame.data ?? '')
            if (frame.type === 'gw_end' || frame.type === 'gw_error') modelCall.done()
            return
          }
          const container = containers.get(frame.runtimeId ?? '')
          if (frame.type === 'ping') send({ type: 'pong' })
          if (frame.type === 'cmd') {
            const op = frame.op ?? ''
            commands.push({ op, ...frame.args })
            const held = heldReplies.get(op)
            heldReplies.delete(op)
            void (held ?? Promise.resolve()).then(() => {
              try {
                send({ type: 'res', id: frame.id, data: run(op, frame.args ?? {}) })
              } catch (error) {
                send({ type: 'res', id: frame.id, error: (error as Error).message })
              }
            })
          }
          if (frame.type === 'http') {
            const isReadyProbe = frame.path === '/ready'
            const isReady = isReadyProbe && container?.running && Date.now() >= (container.readyAt ?? 0)
            const answered =
              container?.running && !isReadyProbe
                ? agentServer?.respond(frame as Parameters<FakeAgentServer['respond']>[0], container)
                : undefined
            void Promise.resolve(answered).then((response) =>
              send({
                type: 'http_res',
                sid: frame.sid,
                status: isReady ? 200 : 503,
                headers: {},
                body: '',
                ...(response as object),
              }),
            )
          }
          const sid = frame.sid ?? 0
          if (frame.type === 'ws_connect' && agentServer && container?.running) {
            send({ type: 'ws_open', sid })
            streams.set(
              sid,
              agentServer.connect({
                path: frame.path ?? '',
                container,
                send: (data) => streams.has(sid) && send({ type: 'ws_msg', sid, data }),
                close: () => {
                  if (streams.delete(sid)) send({ type: 'ws_close', sid })
                },
              }),
            )
          } else if (frame.type === 'ws_connect') send({ type: 'ws_close', sid })
          if (frame.type === 'ws_msg') streams.get(sid)?.onMessage(frame.data ?? '')
          if (frame.type === 'ws_close') {
            streams.get(sid)?.onClose()
            streams.delete(sid)
          }
        }
        await new Promise((resolve) => opened.addEventListener('open', resolve))
        send({
          type: 'hello',
          token,
          gatewayUrl: fakeHostGatewayUrl,
          system: {
            cpus: 4,
            memoryBytes: memoryGibibytes * gibibyte,
            dockerVersion: '29.0.0',
            rootless: true,
            cgroupDriver: 'systemd',
            limitsEnforced: true,
          },
        })
        await waitFor(async () => (await hostStatus(id)) === 'online')
        connectedHosts.add(host)
      },
      disconnect: async () => {
        connectedHosts.delete(host)
        for (const stream of streams.values()) stream.onClose()
        streams.clear()
        socket?.close()
        await waitFor(async () => (await hostStatus(id)) !== 'online')
      },
    }
    await host.connect()
    return host
  }
  return {
    fakeHost,
    disconnectFakeHosts: async () => {
      for (const host of connectedHosts) await host.disconnect()
    },
  }
}
