import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { schema } from '@hq/db/zero'
import { createZeroStore } from '@hq/db/zero-store'
import { type ChatId, chatId, type MemberId, type WorkspaceId } from '@hq/kernel'
import {
  agentServerImage,
  createRuntimeJobs,
  createRuntimeTransactor,
  ensureRuntimeRunning,
  touchRuntime,
} from '@hq/runtime/server'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { startJobWorker } from '../job-worker.ts'
import {
  acme,
  alice,
  aliceInAcme,
  globex,
  issueTestSession,
  openSharedTestApp,
  requestMutation,
  bobInAcme,
  succeeded,
  testAuthSettings,
  waitFor,
} from '../testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const { database, zeroCacheUrl } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({ databases: () => [database] })
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 300,
  sandboxProvider: gateway.sandboxProvider,
})
const zeroDatabase = zeroDrizzle(schema, database)
const runtimeJobs = createRuntimeJobs(gateway.sandboxProvider)
const connectedHosts = new Set<FakeHost>()
const openedStores: ReturnType<typeof createZeroStore>[] = []
afterEach(async () => {
  for (const host of connectedHosts) await host.disconnect()
})
afterAll(async () => {
  await worker.stop()
  await Promise.all(openedStores.map((store) => store.close()))
  void server.stop(true)
})

type Frame = { type: string; id?: number; sid?: number; op?: string; args?: Record<string, string>; path?: string }
type Command = { op: string; runtimeId?: string; image?: string; apiKey?: string }
type FakeHost = Awaited<ReturnType<typeof fakeHost>>
const gibibyte = 1024 ** 3
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

const hostStatus = async (hostId: string) =>
  (await database.$client`select status from runtime_hosts where id = ${hostId}`)[0]?.status

const fakeHost = async (name: string, { memoryGibibytes = 8 } = {}) => {
  const id = crypto.randomUUID()
  const token = sha256(id)
  await database.$client`
    insert into runtime_hosts (workspace_id, id, name, token_hash, status, running_runtimes, created_by, created_at)
    values (${acme}, ${id}, ${name}, ${sha256(token)}, 'offline', 0, ${alice}, now())`
  const containers = new Map<string, { running: boolean; apiKey: string }>()
  const commands: Command[] = []
  const heldReplies = new Map<string, Promise<void>>()
  const run = (op: string, { runtimeId = '', apiKey = '' }: Record<string, string>) => {
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
    hold: (op: string) => {
      const { promise, resolve } = Promise.withResolvers<void>()
      heldReplies.set(op, promise)
      return resolve
    },
    lifecycleCommands: () =>
      commands.filter(({ op }) => ['create', 'start', 'stop', 'remove'].includes(op)).map(({ op }) => op),
    closed: () => closed,
    connect: async () => {
      const opened = new WebSocket(`ws://localhost:${server.port}/host`)
      socket = opened
      closed = new Promise((resolve) => opened.addEventListener('close', () => resolve()))
      const send = (frame: object) => opened.send(JSON.stringify(frame))
      opened.onmessage = (message) => {
        const frame = JSON.parse(String(message.data)) as Frame & { runtimeId?: string }
        if (frame.type === 'ping') send({ type: 'pong' })
        if (frame.type === 'cmd') {
          const op = frame.op ?? ''
          commands.push({ op, ...frame.args })
          const held = heldReplies.get(op)
          heldReplies.delete(op)
          void (held ?? Promise.resolve()).then(() =>
            send({ type: 'res', id: frame.id, data: run(op, frame.args ?? {}) }),
          )
        }
        if (frame.type === 'http') {
          const isReady = frame.path === '/ready' && containers.get(frame.runtimeId ?? '')?.running
          send({ type: 'http_res', sid: frame.sid, status: isReady ? 200 : 503, headers: {}, body: '' })
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

const newRuntimeChat = async (name = 'Runtime chat') => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, owner_kind, owner_user_id, name, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'user', ${alice}, ${name}, false, now())`
  return chatId(id)
}

const ensure = (chat: ChatId) =>
  zeroDatabase.transaction((tx) =>
    ensureRuntimeRunning(
      { transactor: createRuntimeTransactor(tx) },
      { workspaceId: acme, chatId: chat, id: crypto.randomUUID(), now: Date.now() },
    ),
  )
const touch = (chat: ChatId) =>
  zeroDatabase.transaction((tx) =>
    touchRuntime({ transactor: createRuntimeTransactor(tx) }, { workspaceId: acme, chatId: chat, now: Date.now() }),
  )
const sweep = () =>
  runtimeJobs['runtime.sweep']({
    workspaceId: acme,
    payload: {},
    isLastAttempt: false,
    transact: (work) => zeroDatabase.transaction(work),
  })
const runtimeOf = async (chat: ChatId) => {
  const [row] = await database.$client`select * from runtimes where chat_id = ${chat}`
  if (!row) throw new Error(`No runtime for ${chat}`)
  return row
}
const runtimeIn = (chat: ChatId, state: string) =>
  waitFor(async () => (await database.$client`select state from runtimes where chat_id = ${chat}`)[0]?.state === state)
const runningRuntime = async (chat: ChatId) => {
  await ensure(chat)
  await runtimeIn(chat, 'running')
  return runtimeOf(chat)
}
const idleFor = (chat: ChatId, interval: string) =>
  database.$client`update runtimes set last_active_at = now() - ${interval}::interval where chat_id = ${chat}`
const stoppedRuntime = async (chat: ChatId) => {
  const runtime = await runningRuntime(chat)
  await idleFor(chat, '2 hours')
  await sweep()
  await runtimeIn(chat, 'stopped')
  return runtime
}
const archive = (chat: ChatId) =>
  requestMutation(app, database, aliceInAcme, 'workspace.archiveChat', { workspaceId: acme, chatId: chat })
const jobsOf = async (type: string, runtimeId: string) =>
  [...(await database.$client`select * from jobs where type = ${type}`)].filter(
    (job) => job.payload.runtimeId === runtimeId,
  )
const storedSecret = async (ref: string) =>
  (await database.$client`select value from placeholder_secrets where ref = ${ref}`)[0]?.value

test('ensureRuntimeRunning places a runtime on the least-loaded online host, creates, starts and waits for ready', async () => {
  const firstHost = await fakeHost('First host')
  const secondHost = await fakeHost('Second host')
  const firstChat = await newRuntimeChat()
  const secondChat = await newRuntimeChat()
  const placed = await ensure(firstChat)
  expect(placed).toMatchObject({ state: 'creating', failure: null })
  const loadedHost = placed.hostId === firstHost.id ? firstHost : secondHost
  const idleHost = loadedHost === firstHost ? secondHost : firstHost

  const runtime = await runningRuntime(secondChat)
  expect(runtime).toMatchObject({ host_id: idleHost.id, image: agentServerImage, state: 'running', failure: null })
  expect(idleHost.lifecycleCommands()).toEqual(['create', 'start'])
  const created = idleHost.commands.find((command) => command.op === 'create')
  expect(created).toMatchObject({ runtimeId: runtime.id, image: agentServerImage })
  expect(created?.apiKey?.length).toBeGreaterThanOrEqual(16)
  expect(idleHost.commands.some((command) => command.op === 'prepare' && command.image === agentServerImage)).toBe(true)
  await runtimeIn(firstChat, 'running')
})

test('placement fails with no_host, then no_capacity, and a later call after a host comes online creates afresh', async () => {
  const homelessChat = await newRuntimeChat()
  const failed = await ensure(homelessChat)
  expect(failed).toMatchObject({ state: 'failed', failure: 'no_host', hostId: null })
  expect(await jobsOf('runtime.create', failed.id)).toEqual([])

  const smallHost = await fakeHost('Small host', { memoryGibibytes: 3 })
  await runningRuntime(await newRuntimeChat())
  expect(await ensure(await newRuntimeChat())).toMatchObject({ state: 'failed', failure: 'no_capacity' })

  const roomyHost = await fakeHost('Roomy host')
  const retried = await ensure(homelessChat)
  expect(retried).toMatchObject({ state: 'creating', hostId: roomyHost.id })
  expect(retried.id).not.toBe(failed.id)
  await runtimeIn(homelessChat, 'running')
  expect(smallHost.lifecycleCommands()).toEqual(['create', 'start'])
})

test('ten concurrent ensureRuntimeRunning calls for one chat create one runtime and one create command', async () => {
  const host = await fakeHost('Busy host')
  const chat = await newRuntimeChat()
  await Promise.all(Array.from({ length: 10 }, () => ensure(chat)))
  const runtime = await runningRuntime(chat)
  expect(await database.$client`select id from runtimes where chat_id = ${chat}`).toHaveLength(1)
  expect(host.lifecycleCommands()).toEqual(['create', 'start'])
  expect(await jobsOf('runtime.create', runtime.id)).toHaveLength(1)
})

test('a stopped runtime resumes with start only; a missing container is recreated with the same id and key', async () => {
  const host = await fakeHost('Resuming host')
  const chat = await newRuntimeChat()
  const runtime = await stoppedRuntime(chat)
  const apiKey = host.containers.get(runtime.id)?.apiKey
  expect(host.containers.get(runtime.id)?.running).toBe(false)
  host.commands.length = 0

  expect(await ensure(chat)).toMatchObject({ id: runtime.id, state: 'starting' })
  await runtimeIn(chat, 'running')
  expect(host.lifecycleCommands()).toEqual(['start'])

  await stoppedRuntime(chat)
  host.containers.delete(runtime.id)
  host.commands.length = 0
  await ensure(chat)
  await runtimeIn(chat, 'running')
  expect(host.lifecycleCommands()).toEqual(['create', 'start'])
  expect(host.commands.find((command) => command.op === 'create')).toMatchObject({ runtimeId: runtime.id, apiKey })
  expect(await runtimeOf(chat)).toMatchObject({ id: runtime.id, api_key_ref: runtime.api_key_ref })
  expect(await storedSecret(runtime.api_key_ref)).toBe(apiKey)
})

test('the sweep stops runtimes idle for more than an hour only, and touchRuntime postpones it', async () => {
  const host = await fakeHost('Sweeping host')
  const [idleChat, activeChat, touchedChat] = [await newRuntimeChat(), await newRuntimeChat(), await newRuntimeChat()]
  const idle = await runningRuntime(idleChat)
  await runningRuntime(activeChat)
  await runningRuntime(touchedChat)
  await idleFor(idleChat, '61 minutes')
  await idleFor(activeChat, '59 minutes')
  await idleFor(touchedChat, '61 minutes')
  await touch(touchedChat)
  const touchedAt = new Date((await runtimeOf(touchedChat)).last_active_at)
  expect(Date.now() - touchedAt.getTime()).toBeLessThan(5000)
  await touch(touchedChat)
  expect(new Date((await runtimeOf(touchedChat)).last_active_at)).toEqual(touchedAt)

  await sweep()
  await runtimeIn(idleChat, 'stopped')
  expect((await runtimeOf(activeChat)).state).toBe('running')
  expect((await runtimeOf(touchedChat)).state).toBe('running')
  expect(host.commands.filter((command) => command.op === 'stop').map((command) => command.runtimeId)).toEqual([
    idle.id,
  ])
})

test('the sweep removes runtimes stopped for 30 days with their container, volumes and secret, keeping the chat history', async () => {
  const host = await fakeHost('Removing host')
  const oldChat = chatId('chat-invoice-bug')
  const recentChat = await newRuntimeChat()
  const old = await stoppedRuntime(oldChat)
  await stoppedRuntime(recentChat)
  const historyOf = async () => ({
    events: (await database.$client`select id from events where chat_id = ${oldChat}`).length,
    messages: (await database.$client`select id from messages where chat_id = ${oldChat}`).length,
  })
  const history = await historyOf()
  expect(history.messages).toBeGreaterThan(0)
  expect(await storedSecret(old.api_key_ref)).toBeDefined()

  await idleFor(oldChat, '31 days')
  await idleFor(recentChat, '29 days')
  await sweep()
  await runtimeIn(oldChat, 'removed')
  expect((await runtimeOf(recentChat)).state).toBe('stopped')
  expect(host.containers.has(old.id)).toBe(false)
  expect(host.commands.filter((command) => command.op === 'remove').map((command) => command.runtimeId)).toEqual([
    old.id,
  ])
  expect(await storedSecret(old.api_key_ref)).toBeUndefined()
  expect(await historyOf()).toEqual(history)
})

test('archiving a runtime chat removes its runtime', async () => {
  const host = await fakeHost('Archiving host')
  const chat = await newRuntimeChat()
  const runtime = await runningRuntime(chat)
  expect(await archive(chat)).toEqual(succeeded)
  await runtimeIn(chat, 'removed')
  expect(host.containers.has(runtime.id)).toBe(false)
  expect(await storedSecret(runtime.api_key_ref)).toBeUndefined()
})

test('commands to an offline host retry until it returns, rows stay untouched meanwhile, and hello reconciles drift', async () => {
  const host = await fakeHost('Flaky host')
  const [stoppingChat, vanishedChat, revivedChat] = [
    await newRuntimeChat(),
    await newRuntimeChat(),
    await newRuntimeChat(),
  ]
  const stopping = await runningRuntime(stoppingChat)
  const vanished = await runningRuntime(vanishedChat)
  const revived = await stoppedRuntime(revivedChat)
  await host.disconnect()
  const before = [await runtimeOf(vanishedChat), await runtimeOf(revivedChat)]

  await idleFor(stoppingChat, '2 hours')
  await sweep()
  await waitFor(async () => (await jobsOf('runtime.stop', stopping.id)).some((job) => job.last_error !== null))
  await Bun.sleep(200)
  expect((await runtimeOf(stoppingChat)).state).toBe('stopping')
  expect([await runtimeOf(vanishedChat), await runtimeOf(revivedChat)]).toEqual(before)

  host.containers.delete(vanished.id)
  const revivedContainer = host.containers.get(revived.id)
  if (revivedContainer) revivedContainer.running = true
  await host.connect()
  await runtimeIn(stoppingChat, 'stopped')
  await runtimeIn(vanishedChat, 'stopped')
  await runtimeIn(revivedChat, 'running')
  expect(host.containers.get(stopping.id)?.running).toBe(false)
  await waitFor(async () =>
    (await jobsOf('runtime.stop', stopping.id)).some((job) => job.state === 'done' && job.attempts >= 2),
  )
})

test('removing a host marks its runtimes failed/lost', async () => {
  const host = await fakeHost('Doomed host')
  const [runningChat, stoppedChat] = [await newRuntimeChat(), await newRuntimeChat()]
  await runningRuntime(runningChat)
  await stoppedRuntime(stoppedChat)
  expect(
    await requestMutation(app, database, aliceInAcme, 'runtime.removeHost', { workspaceId: acme, hostId: host.id }),
  ).toEqual(succeeded)
  await host.closed()
  connectedHosts.delete(host)
  for (const chat of [runningChat, stoppedChat])
    expect(await runtimeOf(chat)).toMatchObject({ state: 'failed', failure: 'lost' })
  expect(await archive(runningChat)).toEqual(succeeded)
  expect((await runtimeOf(runningChat)).state).toBe('removed')
})

test('the API key and its ref never reach Zero rows or logs, and other workspaces never see the runtime', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => spyOn(console, method))
  try {
    const host = await fakeHost('Secret host')
    const chat = await newRuntimeChat()
    const runtime = await runningRuntime(chat)
    const apiKey = host.containers.get(runtime.id)?.apiKey ?? ''
    expect(apiKey).not.toBe('')
    const openStore = async (member: { workspaceId: WorkspaceId; userId: MemberId }) => {
      const session = await issueTestSession(database, member.workspaceId, member.userId)
      const store = createZeroStore({
        memberId: member.userId,
        sessions: [{ ...session, workspaceId: member.workspaceId }],
        renew: async () => undefined,
        cacheURL: zeroCacheUrl,
        kvStore: 'mem',
      })
      openedStores.push(store)
      await store.whenLoaded(member.workspaceId)
      return store
    }
    const bobsAcme = await openStore(bobInAcme)
    await waitFor(() => bobsAcme.read().runtimes.some((row) => row.chatId === chat && row.state === 'running'))
    const alicesGlobex = await openStore({ workspaceId: globex, userId: alice })
    expect(alicesGlobex.read().runtimes).toEqual([])
    const replicated = JSON.stringify(bobsAcme.read().runtimes)
    for (const secret of [apiKey, runtime.api_key_ref, 'apiKeyRef']) expect(replicated).not.toContain(secret)
    const [published] = await database.$client<{ columns: string[] }[]>`
      select attnames as columns from pg_publication_tables where pubname = 'hq_zero' and tablename = 'runtimes'`
    expect(published?.columns).toContain('state')
    expect(published?.columns).not.toContain('api_key_ref')

    await stoppedRuntime(chat)
    await ensure(chat)
    await runtimeIn(chat, 'running')
    expect(await archive(chat)).toEqual(succeeded)
    await runtimeIn(chat, 'removed')
    const logged = spies.map((spy) => Bun.inspect(spy.mock.calls)).join('\n')
    for (const secret of [apiKey, runtime.api_key_ref]) expect(logged).not.toContain(secret)
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
})

const promptly = <Result>(work: Promise<Result>) =>
  Promise.race([
    work,
    Bun.sleep(1000).then(() => {
      throw new Error('No answer within 1 s')
    }),
  ])
const transactionsLeftOpen = () =>
  database.$client`
    select pid, query from pg_stat_activity
    where datname = current_database() and state like 'idle in transaction%'`
const repliesTo = async (messageId: string) =>
  (await database.$client`select id from messages where reply_to_id = ${messageId}`).length

test('a slow start holds no transaction: ensureRuntimeRunning answers and other jobs complete meanwhile', async () => {
  const host = await fakeHost('Slow host')
  const [slowChat, otherChat] = [await newRuntimeChat(), await newRuntimeChat()]
  const releaseStart = host.hold('start')
  try {
    const slow = await ensure(slowChat)
    await waitFor(() => host.commands.some((command) => command.op === 'start' && command.runtimeId === slow.id))
    await Bun.sleep(100)
    expect([...(await transactionsLeftOpen())]).toEqual([])
    expect(await promptly(ensure(slowChat))).toMatchObject({ id: slow.id, state: 'creating' })

    const repliesBefore = await repliesTo('message-welcome-1')
    await database.$client`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${acme}, ${crypto.randomUUID()}, 'agent.reply', ${JSON.stringify({ messageId: 'message-welcome-1' })}::jsonb, now(), 0, 'queued')`
    await waitFor(async () => (await repliesTo('message-welcome-1')) === repliesBefore + 1, 3000)
    await promptly(runningRuntime(otherChat))
    expect((await runtimeOf(slowChat)).state).toBe('creating')
  } finally {
    releaseStart()
  }
  await runtimeIn(slowChat, 'running')
})

test('a runtime job whose worker died after claiming it is claimed again once its lease expires, and converges', async () => {
  const host = await fakeHost('Crashed worker host')
  const chat = await newRuntimeChat()
  const id = crypto.randomUUID()
  const apiKey = 'an-api-key-generated-before-the-crash'
  await database.$client.begin(async (sql) => {
    await sql`insert into placeholder_secrets (workspace_id, ref, value) values (${acme}, ${`placeholder:${id}`}, ${apiKey})`
    await sql`
      insert into runtimes (workspace_id, id, chat_id, host_id, state, image, api_key_ref, last_active_at, created_at, state_changed_at)
      values (${acme}, ${id}, ${chat}, ${host.id}, 'creating', ${agentServerImage}, ${`placeholder:${id}`}, now(), now(), now())`
    await sql`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${acme}, ${`job-${id}`}, 'runtime.create', ${JSON.stringify({ runtimeId: id })}::jsonb, now() + interval '1 second', 0, 'running')`
  })
  host.containers.set(id, { running: false, apiKey })

  await runtimeIn(chat, 'running')
  expect(host.lifecycleCommands()).toEqual(['start'])
  await waitFor(async () => (await jobsOf('runtime.create', id))[0]?.state === 'done')
  expect(await jobsOf('runtime.create', id)).toMatchObject([{ state: 'done', attempts: 2 }])
})
