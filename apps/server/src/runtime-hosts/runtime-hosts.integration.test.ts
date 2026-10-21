import { afterAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createZeroStore } from '@spyria/db/zero-store'
import { defaultHarness, runtimeHostId } from '@spyria/kernel'
import { runtimeMutators } from '@spyria/runtime/server'
import { createApp } from '../app.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  bobInAcme,
  captureConsole,
  failedWith,
  globex,
  lee,
  openSharedTestApp,
  openZeroStore,
  removeFromAcme,
  requestMutation,
  sessionTokenOf,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing/testing.ts'
import { createRuntimeHostGateway, maximumFrameBytes, serverWebSocket } from './gateway.ts'

const { database } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({ databases: () => [database], pingIntervalMilliseconds: 100 })
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket: serverWebSocket })
const openedSockets: WebSocket[] = []
afterAll(() => {
  for (const socket of openedSockets) socket.close()
  void server.stop(true)
})

type Member = { workspaceId: string; userId: string }
type Frame = { type: string; [field: string]: unknown }
const aliceInGlobex = { workspaceId: globex, userId: alice }
const leeInAcme = { workspaceId: acme, userId: lee }
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
  return { socket, send, closed, frameOrClose, frames }
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

const openStore = (member: Member) => openZeroStore(createZeroStore, member.userId, [member.workspaceId])

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

test('a claim of an unknown, used, expired or removed code and a hello without a registered token or with the wrong personal flag are refused', async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
  const tokenOf = async (code: string | undefined) => {
    const { host, token } = await claim(String(code))
    host.socket.close()
    return token
  }
  const helloRefusal = async (hello: object) => {
    const host = await connectFakeHost()
    host.send({ type: 'hello', system: hostSystem, ...hello })
    return (await host.closed).reason
  }
  const refusals = {
    'unknown code': async () => refusalOf((await claim('ZZZZZZZZ')).outcome),
    'used code': async () => {
      const { id, code, host } = await pairedHost()
      const refusal = await refusalOf((await claim(code)).outcome)
      expect((await hostRow(id)).status).toBe('online')
      expect(host.socket.readyState).toBe(WebSocket.OPEN)
      return refusal
    },
    'expired code': async () => {
      const { id, code } = await addedHost()
      await database.$client`update runtime_hosts set claim_expires_at = now() - interval '1 second' where id = ${id}`
      const refusal = await refusalOf((await claim(code)).outcome)
      expect((await hostRow(id)).status).toBe('expired')
      return refusal
    },
    'code of a removed host': async () => {
      const { id, code } = await addedHost()
      expect(await removeHost(aliceInAcme, acme, id)).toEqual(succeeded)
      return refusalOf((await claim(code)).outcome)
    },
    'hello without a token': () => helloRefusal({}),
    'hello with a wrong token': () => helloRefusal({ token: 'x'.repeat(43) }),
    'machine hello without personal': async () =>
      helloRefusal({ token: await tokenOf((await addMachine(bobInAcme)).body?.code) }),
    'workspace host hello with personal': async () =>
      helloRefusal({ token: await tokenOf((await addedHost('Workspace box')).code), personal: true }),
  }
  const reasons: Record<string, string> = {}
  for (const [name, refused] of Object.entries(refusals)) reasons[name] = await refused()
  expect(reasons).toEqual({
    'unknown code': 'This code is not valid',
    'used code': 'This code was already used',
    'expired code': 'This code has expired',
    'code of a removed host': 'This host was removed',
    'hello without a token': 'This host is not registered',
    'hello with a wrong token': 'This host is not registered',
    'machine hello without personal': 'This host was paired as your machine: restart spyria-host with --personal',
    'workspace host hello with personal':
      'This host was paired as a workspace host: restart spyria-host without --personal',
  })
})

test('a valid code yields one token whose hash only is stored, a renewed code pairs the same expired row, and a hello sets the host online with its capacity or a machine’s sign-in', async () => {
  const { id, code } = await addedHost()
  const { host: claimingHost, token } = await claim(code)
  claimingHost.socket.close()
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  const claimed = await hostRow(id)
  expect(claimed.token_hash).toBe(sha256(token ?? ''))
  expect(JSON.stringify(claimed)).not.toContain(token)
  const host = await connectFakeHost()
  host.send({ type: 'hello', token, system: hostSystem })
  await waitFor(async () => (await hostRow(id)).status === 'online')
  const online = await hostRow(id)
  expect(online.capacity).toEqual({ ...hostSystem, cap: 6 })
  expect(online.running_runtimes).toBe(0)
  expect(online.last_seen_at).toBeInstanceOf(Date)

  const expiring = await addedHost()
  await database.$client`update runtime_hosts set claim_expires_at = now() - interval '1 second' where id = ${expiring.id}`
  expect(await refusalOf((await claim(expiring.code)).outcome)).toBe('This code has expired')
  const renewed = await renewCode(aliceInAcme, expiring.id)
  expect(renewed.status).toBe(200)
  expect(renewed.body?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
  expect((await hostRow(expiring.id)).status).toBe('waiting')
  expect(await refusalOf((await claim(expiring.code)).outcome)).toBe('This code is not valid')
  expect((await claim(renewed.body?.code ?? '')).token).toBeDefined()
  expect(await renewCode(aliceInAcme, expiring.id)).toMatchObject({
    status: 400,
    body: { error: 'code_not_renewable' },
  })

  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
  const { id: machineId, host: machine } = await pairedMachine(bobInAcme)
  expect((await hostRow(machineId)).capacity).toEqual({
    ...hostSystem,
    cap: 6,
    personal: true,
    signedIn: [],
    credentialsChangedAt: {},
    expiredSignIns: {},
  })
  machine.send({ type: 'heartbeat', memoryFreeBytes: gibibyte, running: 0, signedIn: [defaultHarness] })
  await waitFor(async () => ((await hostRow(machineId)).capacity as { signedIn: string[] }).signedIn.length === 1)
  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
})

test('renewing refuses a member and the admin of another workspace', async () => {
  const { id } = await addedHost()
  expect((await renewCode(bobInAcme, id)).status).toBe(403)
  expect(await renewCode(aliceInGlobex, id)).toMatchObject({ status: 404, body: { error: 'host_not_found' } })
})

test('heartbeats update last_seen_at, the free memory and the running count', async () => {
  const { id, host } = await pairedHost()
  await database.$client`update runtime_hosts set last_seen_at = last_seen_at - interval '1 minute' where id = ${id}`
  const seenAtHello = (await hostRow(id)).last_seen_at as Date
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
  await Bun.sleep(200)
  expect(secondConnection.socket.readyState).toBe(WebSocket.OPEN)
  expect((await hostRow(id)).status).toBe('online')
})

test('a host frame at the explicit 64 MiB limit is relayed and the host stays online; one byte more closes that connection', async () => {
  const { id, host } = await pairedHost()
  const sandbox = { workspaceId: acme, hostId: runtimeHostId(id), runtimeId: 'large-bundle' }
  const answerAtSize = async (frameBytes: number) => {
    const { frame } = (await host.frameOrClose('http')) as { frame: Frame }
    const envelope = { type: 'http_res', sid: frame.sid, status: 200, headers: {}, body: '' }
    const bodyLength = frameBytes - JSON.stringify(envelope).length
    host.send({ ...envelope, body: 'b'.repeat(bodyLength) })
    host.frames.splice(0)
    return bodyLength
  }
  const relayed = gateway.sandboxProvider.connect(sandbox).fetch({ method: 'POST', path: '/api/workspace/bundle' })
  const bodyLength = await answerAtSize(maximumFrameBytes)
  expect((await relayed).body).toHaveLength(bodyLength)
  await Bun.sleep(200)
  expect(host.socket.readyState).toBe(WebSocket.OPEN)
  expect((await hostRow(id)).status).toBe('online')

  const tooLarge = gateway.sandboxProvider.connect(sandbox).fetch({ method: 'POST', path: '/api/workspace/bundle' })
  await answerAtSize(maximumFrameBytes + 1)
  await expect(tooLarge).rejects.toThrow()
  expect((await host.closed).code).toBe(1006)
  await waitFor(async () => (await hostRow(id)).status === 'offline')
}, 30_000)

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

test('a member cannot remove a host or turn machine sessions off, and the admin of another workspace cannot reach it', async () => {
  const { id, host } = await pairedHost()
  expect(await removeHost(bobInAcme, acme, id)).toEqual(
    failedWith('Your workspace role does not allow this: Manage runtime hosts and local sessions'),
  )
  expect(
    await requestMutation(app, database, bobInAcme, 'runtime.setLocalSessions', { workspaceId: acme, isOn: false }),
  ).toEqual(failedWith('Your workspace role does not allow this: Manage runtime hosts and local sessions'))
  expect((await database.$client`select local_sessions from workspaces where workspace_id = ${acme}`)[0]).toEqual({
    local_sessions: true,
  })
  expect(await removeHost(aliceInGlobex, acme, id)).toEqual(
    failedWith('A runtime host can only be managed in the current workspace'),
  )
  expect(await removeHost(aliceInGlobex, globex, id)).toEqual(failedWith(`Runtime host ${id} was not found`))
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
})

test('neither a claim code nor a host token is ever logged', async () => {
  const consoleCalls = captureConsole()
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
    for (const secret of [code, pairedCode, token]) expect(consoleCalls.logged()).not.toContain(secret)
  } finally {
    consoleCalls.restore()
  }
})

const addMachine = (member: Member) => postAs(member, '/api/runtime-hosts', { personal: true })
const pairedMachine = async (member: Member) => {
  const { body } = await addMachine(member)
  if (!body?.id || !body.code) throw new Error('Adding a machine failed')
  const { host: claimingHost, token } = await claim(body.code)
  claimingHost.socket.close()
  const host = await connectFakeHost()
  host.send({ type: 'hello', token, system: hostSystem, personal: true, signedIn: [] })
  await waitFor(async () => (await hostRow(body.id as string)).status === 'online')
  return { id: body.id, token, host }
}
const countMachines = async (member: Member) =>
  (
    await app.request('/api/runtime-hosts/machines', {
      headers: { authorization: `Bearer ${await sessionTokenOf(database, member.workspaceId, member.userId)}` },
    })
  ).json()

test('a member adds one machine of their own under a lock on their membership; a second one is refused until it is removed', async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
  const { status, body } = await addMachine(bobInAcme)
  expect(status).toBe(201)
  expect(await hostRow(String(body?.id))).toMatchObject({ owner_id: bob, created_by: bob, name: 'My machine' })
  expect(await addMachine(bobInAcme)).toMatchObject({ status: 400, body: { error: 'machine_already_added' } })
  expect(await removeHost(bobInAcme, acme, String(body?.id))).toEqual(succeeded)
  expect((await addMachine(bobInAcme)).status).toBe(201)

  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
  const memberLocked = Promise.withResolvers<void>()
  const releaseMember = Promise.withResolvers<void>()
  const locking = database.$client.begin(async (sql) => {
    await sql`select 1 from memberships where workspace_id = ${acme} and user_id = ${bob} for no key update`
    memberLocked.resolve()
    await releaseMember.promise
  })
  await memberLocked.promise
  let isAdded = false
  const adding = addMachine(bobInAcme).finally(() => {
    isAdded = true
  })
  await waitFor(
    async () =>
      (
        await database.$client`
          select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike '%memberships%'`
      ).length > 0,
  )
  expect(isAdded).toBe(false)
  releaseMember.resolve()
  await locking
  expect((await adding).status).toBe(201)
})

test('a machine is read and removed by its owner only, and admins see only how many members use one', async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
  const { id, host } = await pairedMachine(bobInAcme)
  const bobsAcme = await openStore(bobInAcme)
  await waitFor(() => bobsAcme.read().runtimeHosts.some((machine) => machine.id === id && machine.status === 'online'))
  expect(bobsAcme.read().runtimeHosts.map((machine) => String(machine.id))).toEqual([id])
  const alicesAcme = await openStore(aliceInAcme)
  expect(alicesAcme.read().runtimeHosts.some((machine) => machine.id === id)).toBe(false)
  expect(await countMachines(aliceInAcme)).toEqual({ count: 1 })
  expect(await countMachines(bobInAcme)).toMatchObject({ error: 'missing_workspace_permission' })
  expect(await removeHost(aliceInAcme, acme, id)).toEqual(failedWith(`Runtime host ${id} was not found`))
  expect(await renewCode(aliceInAcme, id)).toMatchObject({ status: 404, body: { error: 'host_not_found' } })
  expect(await removeHost(bobInAcme, acme, id)).toEqual(succeeded)
  await host.closed
  expect(await countMachines(aliceInAcme)).toEqual({ count: 0 })
})

test('removing a member removes their machine and closes its connection', async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id is not null`
  const { id, host } = await pairedMachine(bobInAcme)
  expect(await removeFromAcme(app, database, bob)).toEqual(succeeded)
  await host.closed
  expect((await hostRow(id)).removed_at).toBeInstanceOf(Date)
})

test('a member promoted to admin reads and manages workspace hosts at once without a new sign-in, and is refused at once when demoted', async () => {
  const changeLeeRole = (role: string) =>
    requestMutation(app, database, aliceInAcme, 'workspace.changeMemberRole', {
      workspaceId: acme,
      memberId: lee,
      role,
    })
  const setLocalSessions = (isOn: boolean) => runtimeMutators.runtime.setLocalSessions({ workspaceId: acme, isOn })
  const localSessionsOn = async () =>
    (await database.$client`select local_sessions from workspaces where workspace_id = ${acme}`)[0]?.local_sessions
  const { id } = await pairedHost('Promotion host')
  const leesAcme = await openStore(leeInAcme)
  expect(leesAcme.read().runtimeHosts).toEqual([])
  expect(await changeLeeRole('admin')).toEqual(succeeded)
  await waitFor(() => leesAcme.read().runtimeHosts.some((host) => host.id === id))
  await (await leesAcme.mutate(acme, setLocalSessions(false))).confirmation
  expect(await localSessionsOn()).toBe(false)
  expect(await changeLeeRole('member')).toEqual(succeeded)
  await waitFor(() => leesAcme.read().runtimeHosts.length === 0)
  await expect(leesAcme.mutate(acme, setLocalSessions(true))).rejects.toThrow(
    'Your workspace role does not allow this: Manage runtime hosts and local sessions',
  )
  expect(await removeHost(leeInAcme, acme, id)).toEqual(
    failedWith('Your workspace role does not allow this: Manage runtime hosts and local sessions'),
  )
  expect(await localSessionsOn()).toBe(false)
  expect(
    await requestMutation(app, database, aliceInAcme, 'runtime.setLocalSessions', { workspaceId: acme, isOn: true }),
  ).toEqual(succeeded)
})
