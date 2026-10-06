import { createHash } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Database, events, resetDatabase } from '@hq/db/postgres'
import { createTestDatabase, startZeroCache } from '@hq/db/testing'
import { memberId, workspaceId } from '@hq/kernel'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { openSessions } from './auth/sessions.ts'

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

const startSharedTestApp = async () => {
  const testDatabase = await createTestDatabase()
  const { database } = testDatabase
  const app = createApp({ database, ...testAuthSettings })
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const stopServerAndDatabase = async () => {
    await server.stop(true)
    await testDatabase.drop()
  }
  const zeroCache = await startZeroCache({
    databaseName: testDatabase.name,
    port: 4890,
    appId: sharedAppId,
    serverUrl: server.url.origin,
  }).catch(async (error) => {
    await stopServerAndDatabase()
    throw error
  })
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
    zeroCacheUrl: zeroCache.url,
    resultOf,
    eventsOf,
    changesOf,
    stop: async () => {
      await zeroCache.stop()
      await stopServerAndDatabase()
    },
  }
}

let sharedTestApp: ReturnType<typeof startSharedTestApp> | undefined

export const openSharedTestApp = async () => {
  sharedTestApp ??= startSharedTestApp()
  const testApp = await sharedTestApp
  await resetDatabase(testApp.database)
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
}
type HostCommand = { op: string; runtimeId?: string; image?: string; apiKey?: string }
export type FakeContainer = { running: boolean; apiKey: string }
export type FakeAgentServer = {
  respond(request: Required<Pick<HostFrame, 'method' | 'path'>> & HostFrame, container: FakeContainer): unknown
  connect(stream: { path: string; container: FakeContainer; send(data: string): void; close(): void }): {
    onMessage(data: string): void
    onClose(): void
  }
}
export type FakeHost = Awaited<ReturnType<ReturnType<typeof createFakeHosts>['fakeHost']>>
const gibibyte = 1024 ** 3
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export const createFakeHosts = ({ port, database }: { port: number; database: Database }) => {
  const connectedHosts = new Set<FakeHost>()
  const hostStatus = async (hostId: string) =>
    (await database.$client`select status from runtime_hosts where id = ${hostId}`)[0]?.status
  const fakeHost = async (
    name: string,
    { memoryGibibytes = 8, agentServer }: { memoryGibibytes?: number; agentServer?: FakeAgentServer } = {},
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
    const run = (op: string, { runtimeId = '', apiKey = '' }: Record<string, string>) => {
      if (failingOps.has(op)) throw new Error(`${op} failed`)
      const container = containers.get(runtimeId)
      if (op === 'create') containers.set(runtimeId, { running: false, apiKey })
      if (op === 'start' && container) container.running = true
      if (op === 'stop' && container) container.running = false
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
      lifecycleCommands: () =>
        commands.filter(({ op }) => ['create', 'start', 'stop', 'remove'].includes(op)).map(({ op }) => op),
      closed: () => closed,
      connect: async () => {
        const opened = new WebSocket(`ws://localhost:${port}/host`)
        socket = opened
        closed = new Promise((resolve) => opened.addEventListener('close', () => resolve()))
        const send = (frame: object) => opened.send(JSON.stringify(frame))
        opened.onmessage = (message) => {
          const frame = JSON.parse(String(message.data)) as HostFrame
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
            const isReady = frame.path === '/ready' && container?.running
            const answered =
              container?.running && !isReady
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
