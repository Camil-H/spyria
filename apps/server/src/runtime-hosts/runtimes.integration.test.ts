import { afterAll, afterEach, expect, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { schema } from '@spyria/db/zero'
import { createZeroStore } from '@spyria/db/zero-store'
import { type ChatId, chatId, defaultHarness } from '@spyria/kernel'
import {
  createRuntimeJobs,
  createRuntimeTransactor,
  ensureRuntimeRunning,
  retryRuntime,
  touchRuntime,
} from '@spyria/runtime/server'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { startJobWorker } from '../job-worker.ts'
import {
  acme,
  alice,
  aliceInAcme,
  bob,
  captureConsole,
  createFakeHosts,
  globex,
  openSharedTestApp,
  openZeroStore,
  requestMutation,
  succeeded,
  testAuthSettings,
  testSpyriaAgentImage,
  waitFor,
} from '../testing/testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const { database } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({ databases: () => [database], spyriaAgentImage: testSpyriaAgentImage })
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 300,
  sandboxProvider: gateway.sandboxProvider,
})
const zeroDatabase = zeroDrizzle(schema, database)
const runtimeJobs = createRuntimeJobs(gateway.sandboxProvider)
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port: Number(server.port), database })
afterEach(disconnectFakeHosts)
afterAll(async () => {
  await worker.stop()
  void server.stop(true)
})

const newRuntimeChat = async (name = 'Runtime chat', readerId?: string, harness: string | null = null) => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, local_session, harness, archived, created_at)
    values (${acme}, ${id}, 'runtime', 'private', 'user', ${alice}, ${name}, ${harness !== null}, ${harness}, false, now())`
  for (const [memberId, roleId] of [[alice, 'owner'], ...(readerId ? [[readerId, 'reader']] : [])] as const)
    await database.$client`
      insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${id}, ${memberId}, ${roleId})`
  return chatId(id)
}

const ensure = (chat: ChatId, spyriaAgentImage = testSpyriaAgentImage) =>
  zeroDatabase.transaction((tx) =>
    ensureRuntimeRunning(
      { transactor: createRuntimeTransactor(tx), spyriaAgentImage },
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
const retry = (chat: ChatId) =>
  zeroDatabase.transaction((tx) =>
    retryRuntime(
      { transactor: createRuntimeTransactor(tx), spyriaAgentImage: testSpyriaAgentImage },
      { workspaceId: acme, chatId: chat, id: crypto.randomUUID(), now: Date.now() },
    ),
  )
const harnessCommands = (host: { commands: { op: string }[] }) =>
  host.commands.filter(({ op }) => ['create', 'installed', 'install', 'start'].includes(op)).map(({ op }) => op)
const newMachine = async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id = ${alice} and removed_at is null`
  return fakeHost('Machine', { ownerId: alice })
}
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
const storedApiKey = async (runtimeId: string) =>
  (await database.$client`select api_key from runtimes where id = ${runtimeId}`)[0]?.api_key

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
  expect(runtime).toMatchObject({ host_id: idleHost.id, image: testSpyriaAgentImage, state: 'running', failure: null })
  expect(idleHost.lifecycleCommands()).toEqual(['create', 'start'])
  const created = idleHost.commands.find((command) => command.op === 'create')
  expect(created).toMatchObject({ runtimeId: runtime.id, image: testSpyriaAgentImage })
  expect(created?.apiKey?.length).toBeGreaterThanOrEqual(16)
  await runtimeIn(firstChat, 'running')
})

test("a runtime on a workspace host or on a machine only ever gets Spyria's content ID, and no Spyria image fails the placement with no_image", async () => {
  const workspaceHost = await fakeHost('Workspace host')
  const machine = await fakeHost('Machine', { ownerId: alice })
  const machineChat = chatId(`chat-${crypto.randomUUID()}`)
  await database.$client`
    insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, local_session, harness, archived, created_at)
    values (${acme}, ${machineChat}, 'runtime', 'private', 'user', ${alice}, 'Machine chat', true, ${defaultHarness}, false, now())`
  const hostChat = await newRuntimeChat()
  for (const chat of [machineChat, hostChat])
    expect(await ensure(chat, '')).toMatchObject({ state: 'failed', failure: 'no_image', hostId: null })
  expect(await ensure(machineChat)).toMatchObject({
    state: 'creating',
    hostId: machine.id,
    image: testSpyriaAgentImage,
  })
  expect(await ensure(hostChat)).toMatchObject({
    state: 'creating',
    hostId: workspaceHost.id,
    image: testSpyriaAgentImage,
  })
  await runtimeIn(machineChat, 'running')
  await runtimeIn(hostChat, 'running')
  for (const host of [workspaceHost, machine]) {
    const images = host.commands.flatMap(({ op, image }) => (image ? [`${op} ${image}`] : []))
    expect(images.toSorted()).toEqual([`create ${testSpyriaAgentImage}`, `prepare ${testSpyriaAgentImage}`])
  }
})

test('placement fails with no_host, then no_capacity, and a later call after a host comes online creates afresh; a machine is never used', async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id = ${alice} and removed_at is null`
  const machine = await fakeHost('Machine', { ownerId: alice })
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
  expect(machine.lifecycleCommands()).toEqual([])
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
  expect(await runtimeOf(chat)).toMatchObject({ id: runtime.id, api_key: apiKey })
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
  expect(await storedApiKey(old.id)).not.toBeNull()

  await idleFor(oldChat, '31 days')
  await idleFor(recentChat, '29 days')
  await sweep()
  await runtimeIn(oldChat, 'removed')
  expect((await runtimeOf(recentChat)).state).toBe('stopped')
  expect(host.containers.has(old.id)).toBe(false)
  expect(host.commands.filter((command) => command.op === 'remove').map((command) => command.runtimeId)).toEqual([
    old.id,
  ])
  expect(await storedApiKey(old.id)).toBeNull()
  expect(await historyOf()).toEqual(history)
})

test('archiving a runtime chat removes its runtime', async () => {
  const host = await fakeHost('Archiving host')
  const chat = await newRuntimeChat()
  const runtime = await runningRuntime(chat)
  expect(await archive(chat)).toEqual(succeeded)
  await runtimeIn(chat, 'removed')
  expect(host.containers.has(runtime.id)).toBe(false)
  expect(await storedApiKey(runtime.id)).toBeNull()
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
  await waitFor(async () =>
    (await jobsOf('runtime.stop', stopping.id)).some((job) => job.last_error !== null && job.attempts >= 2),
  )
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
  for (const chat of [runningChat, stoppedChat])
    expect(await runtimeOf(chat)).toMatchObject({ state: 'failed', failure: 'lost' })
  expect(await archive(runningChat)).toEqual(succeeded)
  expect((await runtimeOf(runningChat)).state).toBe('removed')
})

test('the API key never reaches Zero rows or logs, and other workspaces never see the runtime', async () => {
  const consoleCalls = captureConsole()
  try {
    const host = await fakeHost('Secret host')
    const chat = await newRuntimeChat('Runtime chat', bob)
    const runtime = await runningRuntime(chat)
    const apiKey = host.containers.get(runtime.id)?.apiKey ?? ''
    expect(apiKey).not.toBe('')
    const bobsAcme = await openZeroStore(createZeroStore, bob, [acme])
    await waitFor(() => bobsAcme.read().runtimes.some((row) => row.chatId === chat && row.state === 'running'))
    const alicesGlobex = await openZeroStore(createZeroStore, alice, [globex])
    expect(alicesGlobex.read().runtimes).toEqual([])
    const replicated = JSON.stringify(bobsAcme.read().runtimes)
    for (const secret of [apiKey, 'apiKey']) expect(replicated).not.toContain(secret)

    await stoppedRuntime(chat)
    await ensure(chat)
    await runtimeIn(chat, 'running')
    expect(await archive(chat)).toEqual(succeeded)
    await runtimeIn(chat, 'removed')
    expect(consoleCalls.logged()).not.toContain(apiKey)
  } finally {
    consoleCalls.restore()
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
const sweepsDone = async () =>
  (await database.$client`select id from jobs where type = 'sessions.sweep' and state = 'done'`).length

test('a slow start holds no transaction: ensureRuntimeRunning answers and other jobs complete meanwhile', async () => {
  const host = await fakeHost('Slow host')
  const [slowChat, otherChat] = [await newRuntimeChat(), await newRuntimeChat()]
  const releaseStart = host.hold('start')
  try {
    const slow = await ensure(slowChat)
    await waitFor(() => host.commands.some((command) => command.op === 'start' && command.runtimeId === slow.id))
    expect([...(await transactionsLeftOpen())]).toEqual([])
    expect(await promptly(ensure(slowChat))).toMatchObject({ id: slow.id, state: 'creating' })

    const sweepsBefore = await sweepsDone()
    await database.$client`
      insert into jobs (workspace_id, id, type, payload, run_at, attempts, state)
      values (${acme}, ${crypto.randomUUID()}, 'sessions.sweep', '{}'::jsonb, now(), 0, 'queued')`
    await waitFor(async () => (await sweepsDone()) === sweepsBefore + 1, 3000)
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
    await sql`
      insert into runtimes (workspace_id, id, chat_id, host_id, state, image, api_key, last_active_at, created_at, state_changed_at)
      values (${acme}, ${id}, ${chat}, ${host.id}, 'creating', ${testSpyriaAgentImage}, ${apiKey}, now(), now(), now())`
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

test('a machine session installs its harness once while the runtime reads installing; a restart and a second session install nothing, and a workspace runtime never asks', async () => {
  const workspaceHost = await fakeHost('Workspace host')
  await runningRuntime(await newRuntimeChat())
  const machine = await newMachine()
  const chat = await newRuntimeChat('Machine chat', undefined, defaultHarness)
  const release = machine.hold('install')
  await ensure(chat)
  await runtimeIn(chat, 'installing')
  release()
  await runtimeIn(chat, 'running')
  expect(harnessCommands(machine)).toEqual(['create', 'installed', 'install', 'start'])
  expect(machine.commands.find(({ op }) => op === 'install')).toMatchObject({ harness: defaultHarness })

  machine.commands.length = 0
  await stoppedRuntime(chat)
  await ensure(chat)
  await runtimeIn(chat, 'running')
  await runningRuntime(await newRuntimeChat('Second machine chat', undefined, defaultHarness))
  expect(harnessCommands(machine)).toEqual(['installed', 'start', 'create', 'installed', 'start'])
  expect(workspaceHost.commands.map(({ op }) => op)).not.toContain('installed')
  expect(workspaceHost.commands.map(({ op }) => op)).not.toContain('install')
})

test("a failed install fails the runtime at once with npm's reason, and a retry installs and runs", async () => {
  const machine = await newMachine()
  const chat = await newRuntimeChat('Machine chat', undefined, 'codex')
  const reason =
    "code E404\n404 Not Found - GET http://registry.invalid/@openai%2fcodex - '@openai/codex@0.162.1' is not in this registry."
  machine.failInstall(reason)
  const capturedConsole = captureConsole()
  await ensure(chat)
  await runtimeIn(chat, 'failed')
  capturedConsole.restore()
  expect((await runtimeOf(chat)).failure).toBe(`install_failed: ${reason}`)
  expect(harnessCommands(machine)).toEqual(['create', 'installed', 'install'])

  machine.failInstall(undefined)
  await retry(chat)
  await runtimeIn(chat, 'running')
  expect((await runtimeOf(chat)).failure).toBeNull()
  expect(machine.installedHarnesses).toEqual(new Set(['codex']))
})

test('a failed bring-up stops its container to release its network; a retry removes it from its host, and failed runtimes idle for 30 days are removed by the sweep', async () => {
  const machine = await newMachine()
  const [retriedChat, abandonedChat] = [
    await newRuntimeChat('Retried chat', undefined, 'codex'),
    await newRuntimeChat('Abandoned chat', undefined, 'codex'),
  ]
  machine.failInstall('code E404')
  const capturedConsole = captureConsole()
  for (const chat of [retriedChat, abandonedChat]) {
    await ensure(chat)
    await runtimeIn(chat, 'failed')
  }
  capturedConsole.restore()
  const [failed, abandoned] = [await runtimeOf(retriedChat), await runtimeOf(abandonedChat)]
  const opsOf = (runtimeId: string) =>
    machine.commands.filter((command) => command.runtimeId === runtimeId).map(({ op }) => op)
  await waitFor(() => opsOf(failed.id).includes('stop') && opsOf(abandoned.id).includes('stop'))
  expect(machine.containers.get(failed.id)?.running).toBe(false)

  machine.failInstall(undefined)
  await retry(retriedChat)
  await runtimeIn(retriedChat, 'running')
  await waitFor(() => !machine.containers.has(failed.id))
  expect(opsOf(failed.id).at(-1)).toBe('remove')
  expect((await runtimeOf(retriedChat)).id).not.toBe(failed.id)

  await idleFor(abandonedChat, '29 days')
  await sweep()
  expect((await runtimeOf(abandonedChat)).state).toBe('failed')
  await idleFor(abandonedChat, '31 days')
  await sweep()
  await runtimeIn(abandonedChat, 'removed')
  expect(machine.containers.has(abandoned.id)).toBe(false)
  expect(opsOf(abandoned.id).at(-1)).toBe('remove')
})

test('a Claude Code or Codex session is never placed on a workspace host: with only a workspace host online it fails with no_host', async () => {
  await database.$client`update runtime_hosts set removed_at = now() where owner_id = ${alice} and removed_at is null`
  const workspaceHost = await fakeHost('Workspace host')
  for (const harness of ['claude-code', 'codex']) {
    const failed = await ensure(await newRuntimeChat('Machine chat', undefined, harness))
    expect(failed).toMatchObject({ state: 'failed', failure: 'no_host', hostId: null })
  }
  expect(harnessCommands(workspaceHost)).toEqual([])
})
