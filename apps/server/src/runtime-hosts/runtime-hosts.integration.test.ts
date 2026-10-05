import { afterAll, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createZeroStore } from '@hq/db/zero-store'
import type { MemberId, WorkspaceId } from '@hq/kernel'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import {
  acme,
  alice,
  aliceInAcme,
  globex,
  issueTestSession,
  openSharedTestApp,
  requestMutation,
  bob,
  bobInAcme,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const { database, zeroCacheUrl } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({ databases: () => [database], pingIntervalMilliseconds: 100 })
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const openedStores: ReturnType<typeof createZeroStore>[] = []
const openedSockets: WebSocket[] = []
afterAll(async () => {
  for (const socket of openedSockets) socket.close()
  await Promise.all(openedStores.map((store) => store.close()))
  void server.stop(true)
})

type Member = { workspaceId: string; userId: string }
type Frame = { type: string; [field: string]: unknown }
const aliceInGlobex = { workspaceId: globex, userId: alice }
const gibibyte = 1024 ** 3
const hostSystem = {
  cpus: 4,
  memoryBytes: 8 * gibibyte,
  dockerVersion: '29.0.0',
  rootless: true,
  cgroupDriver: 'systemd',
  limitsEnforced: true,
}
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const postAs = async (member: Member, path: string, body?: object) => {
  const response = await app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(database, member.workspaceId, member.userId)}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json().catch(() => null)) as Record<string, string> | null }
}
const addHost = (member: Member = aliceInAcme, name = 'Home server') => postAs(member, '/api/runtime-hosts', { name })
const renewCode = (member: Member, hostId: string) => postAs(member, `/api/runtime-hosts/${hostId}/code`)
const addedHost = async (name = 'Home server') => {
  const { body } = await addHost(aliceInAcme, name)
  if (!body?.id || !body.code) throw new Error('Adding a host failed')
  return { id: body.id, code: body.code }
}
const timestampColumns = ['claim_expires_at', 'last_seen_at', 'created_at', 'removed_at']
const hostRow = async (hostId: string) => {
  const [row] = await database.$client`select * from runtime_hosts where id = ${hostId}`
  if (!row) throw new Error(`No runtime host ${hostId}`)
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      timestampColumns.includes(column) && value !== null ? new Date(value) : value,
    ]),
  )
}
const removeHost = (member: Member, workspaceId: string, hostId: string) =>
  requestMutation(app, database, member, 'runtime.removeHost', { workspaceId, hostId })

const connectFakeHost = async ({ answersPings = true } = {}) => {
  const socket = new WebSocket(`ws://localhost:${server.port}/host`)
  openedSockets.push(socket)
  const frames: Frame[] = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.onclose = (event) => resolve({ code: event.code, reason: event.reason })
  })
  socket.onmessage = (message) => {
    const frame = JSON.parse(String(message.data)) as Frame
    if (frame.type === 'ping' && answersPings) socket.send(JSON.stringify({ type: 'pong' }))
    frames.push(frame)
  }
  await new Promise((resolve) => {
    socket.onopen = resolve
  })
  const send = (frame: object) => socket.send(JSON.stringify(frame))
  const frameOrClose = async (type: string) => {
    const closure = closed.then((close) => ({ closed: close }))
    for (;;) {
      const frame = frames.find((received) => received.type === type)
      if (frame) return { frame }
      const outcome = await Promise.race([closure, Bun.sleep(10).then(() => null)])
      if (outcome) return outcome
    }
  }
  return { socket, send, closed, frameOrClose }
}

const claim = async (code: string) => {
  const host = await connectFakeHost()
  host.send({ type: 'claim', code })
  const outcome = await host.frameOrClose('token')
  return { host, token: 'frame' in outcome ? String(outcome.frame.token) : undefined, outcome }
}
const refusalOf = async (outcome: Awaited<ReturnType<typeof claim>>['outcome']) =>
  'closed' in outcome ? outcome.closed.reason : 'not refused'

const pairedHost = async (name = 'Home server', options?: { answersPings: boolean }) => {
  const { id, code } = await addedHost(name)
  const { host: claimingHost, token } = await claim(code)
  if (!token) throw new Error('Claiming failed')
  claimingHost.socket.close()
  const host = await connectFakeHost(options)
  host.send({ type: 'hello', token, system: hostSystem })
  await waitFor(async () => (await hostRow(id)).status === 'online')
  return { id, code, token, host }
}

const openStore = async (member: Member) => {
  const session = await issueTestSession(database, member.workspaceId, member.userId)
  const store = createZeroStore({
    memberId: member.userId as MemberId,
    sessions: [{ ...session, workspaceId: session.workspaceId as WorkspaceId }],
    renew: async () => undefined,
    cacheURL: zeroCacheUrl,
    kvStore: 'mem',
  })
  openedStores.push(store)
  await store.whenLoaded(member.workspaceId as WorkspaceId)
  return store
}

const consoleSpies = () => (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))

test('an admin adds a host and receives a one-time code whose hash only is stored', async () => {
  const { status, body } = await addHost(aliceInAcme, '  Home server  ')
  expect(status).toBe(201)
  expect(body?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  const row = await hostRow(body?.id ?? '')
  expect(row).toMatchObject({
    workspace_id: acme,
    name: 'Home server',
    status: 'waiting',
    claim_code_hash: sha256(body?.code ?? ''),
    token_hash: null,
    created_by: alice,
    removed_at: null,
  })
  const expiresInMilliseconds = (row.claim_expires_at as Date).getTime() - Date.now()
  expect(expiresInMilliseconds).toBeGreaterThan(14 * 60_000)
  expect(expiresInMilliseconds).toBeLessThanOrEqual(15 * 60_000)
  expect(JSON.stringify(row)).not.toContain(body?.code)
})

test('adding refuses a member with 403 and a blank name with 400, storing nothing', async () => {
  const hostIds = async () => [...(await database.$client`select id from runtime_hosts`)].map((row) => row.id)
  const before = await hostIds()
  expect(await addHost(bobInAcme)).toMatchObject({ status: 403 })
  expect(await addHost(aliceInAcme, '   ')).toMatchObject({ status: 400, body: { error: 'blank_host_name' } })
  expect((await postAs(aliceInAcme, '/api/runtime-hosts', {})).status).toBe(400)
  expect(await hostIds()).toEqual(before)
})

test('a claim refuses an unknown code; a valid code yields one token whose hash only is stored', async () => {
  expect(await refusalOf((await claim('ZZZZZZZZ')).outcome)).toBe('This code is not valid')
  const { id, code } = await addedHost()
  const { token } = await claim(code)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const row = await hostRow(id)
  expect(row.token_hash).toBe(sha256(token ?? ''))
  expect(JSON.stringify(row)).not.toContain(token)
  expect(await refusalOf((await claim(code)).outcome)).toBe('This code was already used')
})

test('a claim refuses an expired code and marks the row expired; a renewed code pairs the same row', async () => {
  const { id, code } = await addedHost()
  await database.$client`update runtime_hosts set claim_expires_at = now() - interval '1 second' where id = ${id}`
  expect(await refusalOf((await claim(code)).outcome)).toBe('This code has expired')
  expect((await hostRow(id)).status).toBe('expired')
  const renewed = await renewCode(aliceInAcme, id)
  expect(renewed.status).toBe(200)
  expect(renewed.body?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  expect((await hostRow(id)).status).toBe('waiting')
  expect(await refusalOf((await claim(code)).outcome)).toBe('This code is not valid')
  expect((await claim(renewed.body?.code ?? '')).token).toBeDefined()
  expect(await renewCode(aliceInAcme, id)).toMatchObject({ status: 400, body: { error: 'code_not_renewable' } })
})

test('renewing refuses a member and the admin of another workspace', async () => {
  const { id } = await addedHost()
  expect((await renewCode(bobInAcme, id)).status).toBe(403)
  expect(await renewCode(aliceInGlobex, id)).toMatchObject({ status: 404, body: { error: 'host_not_found' } })
})

test('a claim refuses the code of a removed host', async () => {
  const { id, code } = await addedHost()
  expect(await removeHost(aliceInAcme, acme, id)).toEqual(succeeded)
  expect(await refusalOf((await claim(code)).outcome)).toBe('This host was removed')
})

test('a hello with a missing or wrong token is refused; a valid one sets the host online with its capacity', async () => {
  const missing = await connectFakeHost()
  missing.send({ type: 'hello', system: hostSystem })
  expect((await missing.closed).reason).toBe('This host is not registered')
  const wrong = await connectFakeHost()
  wrong.send({ type: 'hello', token: 'x'.repeat(43), system: hostSystem })
  expect((await wrong.closed).reason).toBe('This host is not registered')

  const { id } = await pairedHost()
  const row = await hostRow(id)
  expect(row.capacity).toEqual({ ...hostSystem, cap: 6 })
  expect(row.running_runtimes).toBe(0)
  expect(row.last_seen_at).toBeInstanceOf(Date)
})

test('heartbeats update last_seen_at, the free memory and the running count', async () => {
  const { id, host } = await pairedHost()
  const seenAtHello = (await hostRow(id)).last_seen_at as Date
  await Bun.sleep(5)
  host.send({ type: 'heartbeat', memoryFreeBytes: 3 * gibibyte, running: 2 })
  await waitFor(async () => (await hostRow(id)).running_runtimes === 2)
  const row = await hostRow(id)
  expect((row.last_seen_at as Date).getTime()).toBeGreaterThan(seenAtHello.getTime())
  expect(row.capacity).toMatchObject({ memoryFreeBytes: 3 * gibibyte, cap: 6 })
})

test('a second connection of a host replaces the first, which is closed, and the host stays online', async () => {
  const { id, token, host: firstConnection } = await pairedHost()
  const secondConnection = await connectFakeHost()
  secondConnection.send({ type: 'hello', token, system: hostSystem })
  expect((await firstConnection.closed).reason).toBe('Replaced by a newer connection of this host')
  await Bun.sleep(300)
  expect(secondConnection.socket.readyState).toBe(WebSocket.OPEN)
  expect((await hostRow(id)).status).toBe('online')
})

test('closing the connection marks the host offline', async () => {
  const { id, host } = await pairedHost()
  host.socket.close()
  await waitFor(async () => (await hostRow(id)).status === 'offline')
})

test('two missed pings close the connection and mark the host offline', async () => {
  const { id, host } = await pairedHost('Silent host', { answersPings: false })
  await host.closed
  await waitFor(async () => (await hostRow(id)).status === 'offline')
})

test('removing a host closes its connection and refuses its token afterwards', async () => {
  const { id, token, host } = await pairedHost()
  expect(await removeHost(aliceInAcme, acme, id)).toEqual(succeeded)
  await host.closed
  expect((await hostRow(id)).removed_at).toBeInstanceOf(Date)
  const reconnection = await connectFakeHost()
  reconnection.send({ type: 'hello', token, system: hostSystem })
  expect((await reconnection.closed).reason).toBe('This host was removed')
})

test('a member cannot remove a host and the admin of another workspace cannot reach it', async () => {
  const { id, host } = await pairedHost()
  expect(await removeHost(bobInAcme, acme, id)).toEqual({
    error: 'app',
    message: 'Only workspace admins can manage runtime hosts',
  })
  expect(await removeHost(aliceInGlobex, acme, id)).toEqual({
    error: 'app',
    message: 'A runtime host can only be managed in the current workspace',
  })
  expect(await removeHost(aliceInGlobex, globex, id)).toEqual({
    error: 'app',
    message: `Runtime host ${id} was not found`,
  })
  expect((await hostRow(id)).removed_at).toBeNull()
  expect(host.socket.readyState).toBe(WebSocket.OPEN)
})

test('only the admins of the workspace read its hosts through Zero, never a hash', async () => {
  const { id, code, token } = await pairedHost('Synced host')
  const alicesAcme = await openStore(aliceInAcme)
  await waitFor(() => alicesAcme.read().runtimeHosts.some((host) => host.id === id && host.status === 'online'))
  const bobsAcme = await openStore(bobInAcme)
  const alicesGlobex = await openStore(aliceInGlobex)
  expect(bobsAcme.read().runtimeHosts).toEqual([])
  expect(alicesGlobex.read().runtimeHosts).toEqual([])
  const replicated = JSON.stringify(alicesAcme.read().runtimeHosts)
  for (const secret of [code, token, sha256(code), sha256(token)]) expect(replicated).not.toContain(secret)

  const publishedColumns = await database.$client<{ columns: string[] }[]>`
    select attnames as columns from pg_publication_tables where pubname = 'hq_zero' and tablename = 'runtime_hosts'`
  expect(publishedColumns[0]?.columns).not.toContain('claim_code_hash')
  expect(publishedColumns[0]?.columns).not.toContain('token_hash')
  expect(publishedColumns[0]?.columns).toContain('status')
})

test('neither a claim code nor a host token is ever logged', async () => {
  const spies = consoleSpies()
  try {
    const { code } = await addedHost('Quiet host')
    expect(await refusalOf((await claim(code.split('').reverse().join(''))).outcome)).toBe('This code is not valid')
    const { id, code: pairedCode, token, host } = await pairedHost('Logged host')
    host.send({ type: 'heartbeat', memoryFreeBytes: gibibyte, running: 1 })
    host.send({ type: 'unknown', token })
    host.socket.send('not json')
    await removeHost(aliceInAcme, acme, id)
    await host.closed
    const reconnection = await connectFakeHost()
    reconnection.send({ type: 'hello', token, system: hostSystem })
    await reconnection.closed
    const logged = spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
    for (const secret of [code, pairedCode, token]) expect(logged).not.toContain(secret)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})
