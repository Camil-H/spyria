import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { chatId, runtimeHostId } from '@spyria/kernel'
import {
  createRuntimeJobs,
  createRuntimeTransactor,
  ensureRuntimeRunning,
  removeChatRuntime,
} from '@spyria/runtime/server'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { startJobWorker } from '../job-worker.ts'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import {
  acme,
  aliceInAcme,
  openSharedTestApp,
  rejectionOf,
  sessionTokenOf,
  testAuthSettings,
  waitFor,
} from '../testing/testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const hasDocker = docker('info').exitCode === 0
const spyriaImage = (await readSpyriaAgentImage()) ?? ''
const hasImage = hasDocker && spyriaImage !== '' && docker('image', 'inspect', spyriaImage).exitCode === 0
const skipReason = !hasDocker ? 'Docker is unavailable' : "Spyria's runtime image is not built (bun run agent:build)"
if (!hasImage) console.warn(`Skipping the runtime host Docker test: ${skipReason}`)

const deployment = `spyria-test-${crypto.randomUUID().slice(0, 8)}`
const prefix = `${deployment}-`
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const stateDirectory = mkdtempSync(join(tmpdir(), 'spyria-test-host-'))
const shared = await openSharedTestApp()
const testDatabase = await createTestDatabase()
await testDatabase.database.transaction(await shared.seededGatewayKeys())
const gateway = createRuntimeHostGateway({ databases: () => [testDatabase.database], spyriaAgentImage: spyriaImage })
const app = createApp({ database: testDatabase.database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
let hostProcess: ReturnType<typeof Bun.spawn> | undefined

const removeDockerObjects = () => {
  const containers = dockerText('ps', '-aq', '--filter', `name=^${prefix}`).split('\n').filter(Boolean)
  if (containers.length > 0) docker('rm', '-f', ...containers)
  const volumes = dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}`).split('\n').filter(Boolean)
  if (volumes.length > 0) docker('volume', 'rm', '-f', ...volumes)
  const networks = dockerText('network', 'ls', '-q', '--filter', `name=^${prefix}`).split('\n').filter(Boolean)
  if (networks.length > 0) docker('network', 'rm', ...networks)
}

afterAll(async () => {
  hostProcess?.kill()
  await hostProcess?.exited
  if (hasDocker) removeDockerObjects()
  void server.stop(true)
  await testDatabase.drop()
  rmSync(stateDirectory, { recursive: true, force: true })
}, databaseDropTimeoutMilliseconds)

const connectHost = async () => {
  const added = await app.request('/api/runtime-hosts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(testDatabase.database, acme, aliceInAcme.userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'Docker test host' }),
  })
  const { id, code } = (await added.json()) as { id: string; code: string }
  hostProcess = Bun.spawn([process.execPath, hostProgram, `http://localhost:${server.port}/h/${code}`], {
    env: { ...process.env, SPYRIA_HOST_STATE_DIR: stateDirectory, SPYRIA_DEPLOYMENT: deployment },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitFor(
    async () =>
      (await testDatabase.database.$client`select status from runtime_hosts where id = ${id}`)[0]?.status === 'online',
  )
  return id
}
let connectedHostId: ReturnType<typeof connectHost> | undefined
const hostId = () => {
  connectedHostId ??= connectHost()
  return connectedHostId
}

test.skipIf(!hasImage)(
  "spyria-host creates a hardened runtime from Spyria's image, relays HTTP to spyria-agent, then stops and removes it with its volumes",
  async () => {
    const startedAt = performance.now()
    const id = await hostId()
    const provider = gateway.sandboxProvider
    const runtime = { workspaceId: acme, hostId: runtimeHostId(id), runtimeId: 'docker-test' }
    const apiKey = 'test-api-key-0123456789abcdef'
    const containerName = `${prefix}rt-docker-test`
    expect(
      (await rejectionOf(provider.create({ ...runtime, image: 'docker.io/library/alpine:3', apiKey }))).message,
    ).toContain('refused')
    await provider.create({ ...runtime, image: spyriaImage, apiKey })
    expect(await provider.status(runtime)).toBe('stopped')

    const [inspected] = JSON.parse(dockerText('inspect', containerName))
    expect(inspected.Config.User).toBe('10001:10001')
    expect(inspected.Config.Labels).toMatchObject({ 'spyria.managed': '1', 'spyria.runtime': 'docker-test' })
    expect(inspected.HostConfig).toMatchObject({
      NetworkMode: `${containerName}-net`,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      ReadonlyRootfs: true,
      Privileged: false,
      PublishAllPorts: false,
      Memory: 2 * 1024 ** 3,
      MemorySwap: 2 * 1024 ** 3,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      RestartPolicy: { Name: 'no' },
      PidMode: '',
      UsernsMode: '',
    })
    expect(inspected.HostConfig.IpcMode).not.toBe('host')
    expect(inspected.HostConfig.CapAdd ?? []).toEqual([])
    expect(inspected.HostConfig.Binds ?? []).toEqual([])
    expect(inspected.HostConfig.Devices ?? []).toEqual([])
    expect(Object.keys(inspected.HostConfig.PortBindings ?? {})).toEqual([])
    expect(
      (inspected.HostConfig.Mounts as { Type: string; Source: string; Target: string }[]).map(
        ({ Type, Source, Target }) => `${Type} ${Source} ${Target}`,
      ),
    ).toEqual([
      `volume ${containerName}-ws /workspace`,
      `volume ${containerName}-home /home/openhands`,
      `volume ${containerName}-tmp /tmp`,
    ])

    await provider.start(runtime)
    expect(await provider.status(runtime)).toBe('running')
    const transport = provider.connect(runtime)
    const isReady = () =>
      transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
        (response) => response.status === 200,
        () => false,
      )
    for (const deadline = Date.now() + 30_000; !(await isReady()); await Bun.sleep(100))
      if (Date.now() > deadline) throw new Error('spyria-agent was not ready within 30 s')
    const unauthenticated = await transport.fetch({ method: 'GET', path: '/api/conversations/unknown' })
    expect(unauthenticated.status).toBe(401)
    const authenticated = await transport.fetch({
      method: 'GET',
      path: '/api/conversations/unknown',
      headers: { 'x-session-api-key': apiKey },
    })
    expect(authenticated.status).toBe(404)
    expect((await rejectionOf(transport.fetch({ method: 'GET', path: '@169.254.169.254/' }))).message).toContain(
      'refused',
    )

    await provider.stop(runtime)
    expect(await provider.status(runtime)).toBe('stopped')
    await provider.remove(runtime)
    expect(await provider.status(runtime)).toBe('missing')
    expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${containerName}`)).toBe('')
    expect(dockerText('network', 'ls', '-q', '--filter', `name=^${containerName}-net`)).toBe('')
    console.info(`Runtime host Docker test took ${Math.round(performance.now() - startedAt)} ms`)
  },
  60_000,
)

test.skipIf(!hasImage)(
  "a runtime of another deployment on the same Docker daemon is out of this host's reach, even when its name extends this deployment's",
  async () => {
    const host = { workspaceId: acme, hostId: runtimeHostId(await hostId()) }
    const otherDeploymentRuntime = `${deployment}-rt-rt-other`
    docker(
      ...[
        'run',
        '-d',
        '--name',
        otherDeploymentRuntime,
        '--label',
        'spyria.managed=1',
        '--label',
        'spyria.runtime=other',
      ],
      ...['--entrypoint', 'sleep', spyriaImage, '600'],
    )
    const runtime = { ...host, runtimeId: 'rt-other' }
    expect((await rejectionOf(gateway.sandboxProvider.status(runtime))).message).toContain('refused')
    expect((await rejectionOf(gateway.sandboxProvider.remove(runtime))).message).toContain('refused')
    expect(dockerText('ps', '-q', '--filter', `name=^${otherDeploymentRuntime}$`)).not.toBe('')
  },
  30_000,
)

test.skipIf(!hasImage)(
  'two runtimes on one host cannot reach each other, while spyria-host relays to both',
  async () => {
    const host = { workspaceId: acme, hostId: runtimeHostId(await hostId()) }
    const provider = gateway.sandboxProvider
    const apiKey = 'test-api-key-0123456789abcdef'
    const runtimes = ['isolated-a', 'isolated-b'].map((runtimeId) => ({ ...host, runtimeId }))
    for (const runtime of runtimes) {
      await provider.create({ ...runtime, image: spyriaImage, apiKey })
      await provider.start(runtime)
    }
    const isReady = (runtime: (typeof runtimes)[number]) =>
      provider
        .connect(runtime)
        .fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 })
        .then(
          (response) => response.status === 200,
          () => false,
        )
    for (const runtime of runtimes)
      for (const deadline = Date.now() + 30_000; !(await isReady(runtime)); await Bun.sleep(100))
        if (Date.now() > deadline) throw new Error(`${runtime.runtimeId} was not ready within 30 s`)
    const [first, second] = runtimes.map(({ runtimeId }) => `${prefix}rt-${runtimeId}`)
    const addressOf = (name = '') =>
      dockerText('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name)
    const reaches = (from = '', url: string) =>
      dockerText(
        'exec',
        from,
        'node',
        '-e',
        `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) }).then(() => console.log('reached'), () => console.log('blocked'))`,
      )
    expect(docker('exec', String(first), 'getent', 'hosts', String(second)).exitCode).not.toBe(0)
    expect(reaches(first, `http://${addressOf(first)}:8000/ready`)).toBe('reached')
    if (dockerText('info', '-f', '{{.OperatingSystem}}') === 'OrbStack')
      console.warn('OrbStack accepts traffic between Docker networks: the address check between runtimes is skipped')
    else expect(reaches(first, `http://${addressOf(second)}:8000/ready`)).toBe('blocked')
    for (const runtime of runtimes) await provider.remove(runtime)
  },
  90_000,
)

test.skipIf(!hasImage)(
  "runtime jobs create, stop, resume with the same key and files, and remove a real runtime of Spyria's image; prepare refuses another image",
  async () => {
    const startedAt = performance.now()
    const host = { workspaceId: acme, hostId: runtimeHostId(await hostId()) }
    expect((await rejectionOf(gateway.prepare(host, 'docker.io/library/alpine:3'))).message).toContain('refused')
    const foreignImage = await rejectionOf(
      gateway.prepare(
        host,
        'ghcr.io/openhands/agent-server@sha256:977a4791b90f46c0873f63d879180692802e47e7a0e760ab5add5d5a2505027d',
      ),
    )
    expect(foreignImage.message).toContain('refused')
    await gateway.prepare(host, spyriaImage)

    const { database } = testDatabase
    const worker = startJobWorker(database, { pollIntervalMilliseconds: 20, sandboxProvider: gateway.sandboxProvider })
    const zeroDatabase = zeroDrizzle(schema, database)
    const chat = chatId('chat-invoice-bug')
    const runtimeInput = { workspaceId: acme, chatId: chat, now: Date.now() }
    const ensure = () =>
      zeroDatabase.transaction((tx) =>
        ensureRuntimeRunning(
          { transactor: createRuntimeTransactor(tx), spyriaAgentImage: spyriaImage },
          { ...runtimeInput, id: crypto.randomUUID(), now: Date.now() },
        ),
      )
    const stateIs = (state: string) =>
      waitFor(
        async () => (await database.$client`select state from runtimes where chat_id = ${chat}`)[0]?.state === state,
        30_000,
      )
    try {
      const { id } = await ensure()
      await stateIs('running')
      const containerName = `${prefix}rt-${id}`
      const [stored] = await database.$client`
        select api_key from runtimes where id = ${id}`
      const apiKey = String(stored?.api_key)
      const transport = gateway.sandboxProvider.connect({ ...host, runtimeId: id })
      const authenticatedStatus = async () =>
        (
          await transport.fetch({
            method: 'GET',
            path: '/api/conversations/unknown',
            headers: { 'x-session-api-key': apiKey },
          })
        ).status
      expect(await authenticatedStatus()).toBe(404)
      expect(docker('exec', containerName, 'sh', '-c', 'echo kept > /workspace/kept.txt').exitCode).toBe(0)

      await database.$client`update runtimes set last_active_at = now() - interval '2 hours' where id = ${id}`
      await createRuntimeJobs(gateway.sandboxProvider)['runtime.sweep']({
        workspaceId: acme,
        payload: {},
        isLastAttempt: false,
        transact: (work) => zeroDatabase.transaction(work),
      })
      await stateIs('stopped')
      expect(dockerText('inspect', '-f', '{{.State.Running}}', containerName)).toBe('false')

      expect(await ensure()).toMatchObject({ id, state: 'starting' })
      await stateIs('running')
      expect(dockerText('exec', containerName, 'cat', '/workspace/kept.txt')).toBe('kept')
      expect(await authenticatedStatus()).toBe(404)

      await zeroDatabase.transaction((tx) =>
        removeChatRuntime({ transactor: createRuntimeTransactor(tx) }, { ...runtimeInput, now: Date.now() }),
      )
      await stateIs('removed')
      expect(dockerText('ps', '-aq', '--filter', `name=^${containerName}$`)).toBe('')
      expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${containerName}`)).toBe('')
    } finally {
      await worker.stop()
    }
    console.info(`Runtime lifecycle Docker test took ${Math.round(performance.now() - startedAt)} ms`)
  },
  120_000,
)

test.skipIf(!hasImage)(
  'a runtime holds its Docker network only while it runs: stop releases it, start recreates it and relays again',
  async () => {
    const host = { workspaceId: acme, hostId: runtimeHostId(await hostId()) }
    const provider = gateway.sandboxProvider
    const runtimes = ['cycle-a', 'cycle-b', 'cycle-c'].map((runtimeId) => ({ ...host, runtimeId }))
    const runtimeNetworks = () =>
      dockerText('network', 'ls', '--format', '{{.Name}}', '--filter', `name=^${prefix}rt-cycle-`)
        .split('\n')
        .filter(Boolean)
    const readyOf = (runtime: (typeof runtimes)[number]) =>
      provider
        .connect(runtime)
        .fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 })
        .then(
          (response) => response.status === 200,
          () => false,
        )
    const ready = async (runtime: (typeof runtimes)[number]) => {
      for (const deadline = Date.now() + 30_000; !(await readyOf(runtime)); await Bun.sleep(100))
        if (Date.now() > deadline) throw new Error(`${runtime.runtimeId} was not ready within 30 s`)
    }
    for (const runtime of runtimes) {
      await provider.create({ ...runtime, image: spyriaImage, apiKey: 'test-api-key-0123456789abcdef' })
      await provider.start(runtime)
    }
    for (const runtime of runtimes) await ready(runtime)
    expect(runtimeNetworks()).toHaveLength(3)
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const runtime of runtimes) await provider.stop(runtime)
      expect(runtimeNetworks()).toEqual([])
      for (const runtime of runtimes) await provider.start(runtime)
      expect(runtimeNetworks()).toHaveLength(3)
    }
    for (const runtime of runtimes) await ready(runtime)
    for (const runtime of runtimes) await provider.stop(runtime)
    expect(runtimeNetworks()).toEqual([])
    for (const runtime of runtimes) await provider.remove(runtime)
    expect(dockerText('ps', '-aq', '--filter', `name=^${prefix}rt-cycle-`)).toBe('')
  },
  180_000,
)

test.skipIf(!hasImage)(
  "removing a runtime whose container is gone removes its network and volumes, never another deployment's objects of the same runtime id",
  async () => {
    const host = { workspaceId: acme, hostId: runtimeHostId(await hostId()) }
    const runtime = { ...host, runtimeId: 'orphaned' }
    const otherPrefix = `spyria-test-other-${crypto.randomUUID().slice(0, 8)}-`
    const otherObjects = { network: `${otherPrefix}rt-orphaned-net`, volume: `${otherPrefix}rt-orphaned-ws` }
    try {
      docker('network', 'create', '--label', 'spyria.managed=1', otherObjects.network)
      docker('volume', 'create', otherObjects.volume)
      await gateway.sandboxProvider.create({ ...runtime, image: spyriaImage, apiKey: 'test-api-key-0123456789abcdef' })
      docker('rm', '-f', `${prefix}rt-orphaned`)
      expect(await gateway.sandboxProvider.status(runtime)).toBe('missing')
      expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}rt-orphaned-`)).not.toBe('')
      await gateway.sandboxProvider.remove(runtime)
      expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}rt-orphaned-`)).toBe('')
      expect(dockerText('network', 'ls', '-q', '--filter', `name=^${prefix}rt-orphaned-net$`)).toBe('')
      expect(dockerText('network', 'ls', '-q', '--filter', `name=^${otherObjects.network}$`)).not.toBe('')
      expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${otherObjects.volume}$`)).not.toBe('')
    } finally {
      docker('network', 'rm', otherObjects.network)
      docker('volume', 'rm', '-f', otherObjects.volume)
    }
  },
  60_000,
)
