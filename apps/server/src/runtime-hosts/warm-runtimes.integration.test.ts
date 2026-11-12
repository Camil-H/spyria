import { afterAll, afterEach, expect, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { schema } from '@spyria/db/zero'
import { type ChatId, chatId, type SetupCommand } from '@spyria/kernel'
import { createRuntimeJobs, createRuntimeTransactor, ensureRuntimeRunning } from '@spyria/runtime/server'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { startJobWorker } from '../job-worker.ts'
import type { ContainerAgent, FakeContainer } from '../testing/spyria-agent-relay.ts'
import {
  acme,
  alice,
  captureConsole,
  createFakeHosts,
  type FakeHost,
  openSharedTestApp,
  testAuthSettings,
  testSecretsKeyring,
  testSpyriaAgentImage,
  waitFor,
} from '../testing/testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const installationToken = 'ghs_read_only_installation_token'
const repositoryAccess = {
  cloneOf: async (_workspaceId: string, repository: string) => ({
    url: `https://github.com/${repository}.git`,
    token: installationToken,
  }),
}
const { database } = await openSharedTestApp()
const gateway = createRuntimeHostGateway({
  secretsKeyring: testSecretsKeyring,
  databases: () => [database],
  spyriaAgentImage: testSpyriaAgentImage,
})
const app = createApp({ database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
const worker = startJobWorker(database, {
  pollIntervalMilliseconds: 5,
  retryDelayMilliseconds: 100,
  sandboxProvider: gateway.sandboxProvider,
  spyriaAgentImage: testSpyriaAgentImage,
  repositoryAccess,
  warmCheckMilliseconds: 20,
})
const zeroDatabase = zeroDrizzle(schema, database)
const runtimeJobs = createRuntimeJobs(gateway.sandboxProvider, {
  currentImage: testSpyriaAgentImage,
  repositories: repositoryAccess,
})
const { fakeHost, disconnectFakeHosts } = createFakeHosts({ port: Number(server.port), database })
afterEach(async () => {
  await disconnectFakeHosts()
  await database.$client`update workspaces set setup_commands = '[]'::jsonb where workspace_id = ${acme}`
  await database.$client`update runtime_hosts set removed_at = now() where workspace_id = ${acme} and removed_at is null`
})
afterAll(async () => {
  await worker.stop()
  void server.stop(true)
})

type Preparation = { state: 'preparing' } | { state: 'ready'; branch: string; isSetUp: boolean } | { state: 'failed' }

const preparingAgent = () => {
  const preparations = new Map<FakeContainer, Preparation>()
  const requests: unknown[] = []
  let outcome: Preparation = { state: 'preparing' }
  const containerAgent: ContainerAgent = {
    respond: ({ method, path, body }, container) => {
      if (path !== '/api/prepare') return { status: 404, body: '{}' }
      if (method === 'POST') {
        requests.push(JSON.parse(String(body)))
        preparations.set(container, outcome)
        return { status: 202, body: JSON.stringify(outcome) }
      }
      return { status: 200, body: JSON.stringify(preparations.get(container) ?? outcome) }
    },
    connect: () => ({ onMessage: () => {}, onClose: () => {} }),
  }
  return {
    containerAgent,
    requests,
    finish: (finished: Preparation) => {
      outcome = finished
      for (const container of preparations.keys()) preparations.set(container, finished)
    },
  }
}

const keepReady = (commands: SetupCommand[]) =>
  database.$client`update workspaces set setup_commands = ${JSON.stringify(commands)}::jsonb where workspace_id = ${acme}`
const warmJobsSettled = () =>
  waitFor(
    async () =>
      (
        await database.$client`
          select 1 from jobs where workspace_id = ${acme} and type like 'runtime.warm%' and state in ('queued', 'running')`
      ).length === 0,
  )
const fill = () =>
  runtimeJobs['runtime.warm']({
    workspaceId: acme,
    payload: {},
    isLastAttempt: false,
    isRetry: false,
    transact: (work) => zeroDatabase.transaction(work),
  })
const warmRuntimes = async () =>
  [
    ...(await database.$client`
      select id, state, repository, setup_command, host_id, base_branch from warm_runtimes
      where workspace_id = ${acme} order by created_at`),
  ] as { id: string; state: string; repository: string; setup_command: string; host_id: string; base_branch: string }[]
const warmIn = async (state: string, count: number) =>
  waitFor(async () => (await warmRuntimes()).filter((warm) => warm.state === state).length === count)
const commandsOf = (host: FakeHost, op: string) => host.commands.filter((command) => command.op === op)

const devChat = async (repository: string, baseBranch = 'main') => {
  const id = `chat-${crypto.randomUUID()}`
  await database.$client`
    insert into chats (workspace_id, id, type, visibility, owner_kind, owner_user_id, name, local_session, archived,
      repository, base_branch, created_at)
    values (${acme}, ${id}, 'runtime', 'private', 'user', ${alice}, 'Dev chat', false, false, ${repository},
      ${baseBranch}, now())`
  await database.$client`
    insert into chat_participants (workspace_id, chat_id, user_id, role_id) values (${acme}, ${id}, ${alice}, 'owner')`
  return chatId(id)
}
const ensure = (chat: ChatId) =>
  zeroDatabase.transaction((tx) =>
    ensureRuntimeRunning(
      { transactor: createRuntimeTransactor(tx), spyriaAgentImage: testSpyriaAgentImage },
      { workspaceId: acme, chatId: chat, id: crypto.randomUUID(), now: Date.now() },
    ),
  )

test('runtimes kept ready for a repository are started on a workspace host, prepared with a read-only clone token and its setup command, snapshotted, and a new dev chat on the default branch takes one at once; the pool then fills again', async () => {
  const agent = preparingAgent()
  const host = await fakeHost('Warm host', { memoryGibibytes: 16, containerAgent: agent.containerAgent })
  await warmJobsSettled()
  await keepReady([{ repository: 'acme/app', command: 'bun install', warmRuntimes: 2 }])
  await fill()
  await warmIn('preparing', 2)
  const creates = commandsOf(host, 'create')
  expect(creates).toHaveLength(2)
  const [snapshotKey] = new Set(creates.map((create) => create.snapshotKey))
  expect(snapshotKey).toMatch(/^[a-f0-9]{32}$/)
  expect(creates.every((create) => create.snapshotKey === snapshotKey && !create.packageCacheKey)).toBe(true)
  expect(agent.requests).toEqual([
    { repository: { url: 'https://github.com/acme/app.git', token: installationToken, setup_command: 'bun install' } },
    { repository: { url: 'https://github.com/acme/app.git', token: installationToken, setup_command: 'bun install' } },
  ])

  agent.finish({ state: 'ready', branch: 'main', isSetUp: true })
  await warmIn('ready', 2)
  const warm = await warmRuntimes()
  expect(warm.map(({ base_branch }) => base_branch)).toEqual(['main', 'main'])
  expect(commandsOf(host, 'snapshot').map(({ runtimeId, snapshotKey }) => ({ runtimeId, snapshotKey }))).toEqual(
    expect.arrayContaining(warm.map(({ id }) => ({ runtimeId: id, snapshotKey }))),
  )

  const chat = await devChat('acme/app')
  const claimed = await ensure(chat)
  expect(claimed).toMatchObject({ state: 'running', hostId: host.id, failure: null })
  expect(warm.map(({ id }) => id)).toContain(claimed.id)
  expect((await warmRuntimes()).map(({ id }) => id)).not.toContain(claimed.id)
  const [stored] = await database.$client`select state, api_key_id from runtimes where chat_id = ${chat}`
  expect(stored).toMatchObject({ state: 'running', api_key_id: testSecretsKeyring.currentKeyId })
  await waitFor(async () => (await warmRuntimes()).length === 2)
  await waitFor(() => commandsOf(host, 'create').length === 3)

  const otherBase = await ensure(await devChat('acme/app', 'develop'))
  expect(otherBase).toMatchObject({ state: 'creating' })
  expect((await warmRuntimes()).map(({ id }) => id)).not.toContain(otherBase.id)
  await waitFor(() => commandsOf(host, 'create').some((create) => create.runtimeId === otherBase.id))
  expect(commandsOf(host, 'create').find((create) => create.runtimeId === otherBase.id)?.snapshotKey).toBe(snapshotKey)
  const otherRepository = await ensure(await devChat('acme/site'))
  expect(otherRepository).toMatchObject({ state: 'creating' })
})

test('runtimes kept ready never take a host’s last slot, are replaced when their setup command changes, removed with their pool or their host, and survive a host reconnecting', async () => {
  const agent = preparingAgent()
  const host = await fakeHost('Small host', { memoryGibibytes: 4, containerAgent: agent.containerAgent })
  await warmJobsSettled()
  await keepReady([{ repository: 'acme/app', command: 'bun install', warmRuntimes: 5 }])
  await fill()
  await warmIn('preparing', 1)
  await fill()
  expect(await warmRuntimes()).toHaveLength(1)
  const [first] = await warmRuntimes()

  await host.connect()
  await Bun.sleep(200)
  expect(commandsOf(host, 'remove').map(({ runtimeId }) => runtimeId)).not.toContain(first?.id)

  await keepReady([{ repository: 'acme/app', command: 'bun install --frozen-lockfile', warmRuntimes: 1 }])
  await fill()
  await waitFor(async () =>
    (await warmRuntimes()).some((warm) => warm.setup_command === 'bun install --frozen-lockfile'),
  )
  expect((await warmRuntimes()).map(({ id }) => id)).not.toContain(first?.id)
  await waitFor(() => commandsOf(host, 'remove').some(({ runtimeId }) => runtimeId === first?.id))

  host.commands.length = 0
  await keepReady([{ repository: 'acme/app', command: 'bun install', warmRuntimes: 0 }])
  await fill()
  await waitFor(async () => (await warmRuntimes()).length === 0)
  await waitFor(() => commandsOf(host, 'prune_snapshots').some(({ keep }) => keep?.length === 0))

  await keepReady([{ repository: 'acme/app', command: 'bun install', warmRuntimes: 1 }])
  await fill()
  await waitFor(async () => (await warmRuntimes()).length === 1)
  await host.disconnect()
  expect(await warmRuntimes()).toEqual([])
})

test('a runtime whose preparation fails is removed and holds its place for an hour, so a failing repository is not rebuilt at every sweep; one whose setup failed is kept ready without a snapshot, so the chat runs setup again', async () => {
  const agent = preparingAgent()
  const host = await fakeHost('Failing host', { memoryGibibytes: 8, containerAgent: agent.containerAgent })
  await warmJobsSettled()
  const capturedConsole = captureConsole()
  agent.finish({ state: 'failed' })
  await keepReady([{ repository: 'acme/app', command: 'bun install', warmRuntimes: 1 }])
  await fill()
  await waitFor(() => commandsOf(host, 'remove').length === 1)
  await warmJobsSettled()
  expect((await warmRuntimes()).map(({ state }) => state)).toEqual(['failed'])
  await fill()
  expect(commandsOf(host, 'create')).toHaveLength(1)
  capturedConsole.restore()

  agent.finish({ state: 'ready', branch: 'main', isSetUp: false })
  await keepReady([
    { repository: 'acme/app', command: 'bun install', warmRuntimes: 1 },
    { repository: 'acme/site', command: 'npm ci', warmRuntimes: 1 },
  ])
  await fill()
  await warmIn('ready', 1)
  expect(commandsOf(host, 'snapshot')).toEqual([])
})
