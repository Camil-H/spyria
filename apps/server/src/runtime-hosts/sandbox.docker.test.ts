import { afterAll, expect, test } from 'bun:test'
import { zeroDrizzle } from '@rocicorp/zero/server/adapters/drizzle'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { schema } from '@spyria/db/zero'
import { chatId } from '@spyria/kernel'
import {
  createRuntimeJobs,
  createRuntimeTransactor,
  ensureRuntimeRunning,
  removeChatRuntime,
} from '@spyria/runtime/server'
import { startJobWorker } from '../job-worker.ts'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { startDockerTestHost } from '../testing/docker-runtime-host.ts'
import { acme, openSharedTestApp, rejectionOf, waitFor } from '../testing/testing.ts'

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

const shared = await openSharedTestApp()
const testDatabase = await createTestDatabase()
await testDatabase.database.transaction(await shared.seededGatewayKeys())
let dockerHostStarted: ReturnType<typeof startDockerTestHost> | undefined
const dockerHost = () => {
  dockerHostStarted ??= startDockerTestHost({ database: testDatabase.database, spyriaAgentImage: spyriaImage })
  return dockerHostStarted
}

afterAll(async () => {
  await (await dockerHostStarted)?.cleanup()
  await testDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const dockerOperatingSystem = () => dockerText('info', '-f', '{{.OperatingSystem}}')
const addressOf = (name = '') =>
  dockerText('inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', name)
const reaches = (from = '', url: string) =>
  dockerText(
    'exec',
    from,
    'node',
    '-e',
    `fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(3000) }).then(() => console.log('reached'), (error) => console.log('blocked', error.cause?.code ?? error.name))`,
  )

test.skipIf(!hasImage)(
  "spyria-host creates a hardened runtime from Spyria's image, relays HTTP to spyria-agent, then stops and removes it with its volumes",
  async () => {
    const startedAt = performance.now()
    const { gateway, hostId, prefix, readyRuntime } = await dockerHost()
    const provider = gateway.sandboxProvider
    const runtime = { workspaceId: acme, hostId, runtimeId: 'docker-test' }
    const apiKey = provider.apiKeyOf(runtime)
    const containerName = `${prefix}rt-docker-test`
    expect((await rejectionOf(provider.create({ ...runtime, image: 'docker.io/library/alpine:3' }))).message).toContain(
      'refused',
    )
    await provider.create({ ...runtime, image: spyriaImage })
    expect(await provider.status(runtime)).toBe('stopped')

    const [inspected] = JSON.parse(dockerText('inspect', containerName))
    expect(inspected.Config.User).toBe('10001:10001')
    expect(inspected.Config.Labels).toMatchObject({ 'spyria.managed': '1', 'spyria.runtime': 'docker-test' })
    expect(inspected.HostConfig).toMatchObject({
      Init: true,
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
      `volume ${containerName}-home /home/spyria`,
      `volume ${containerName}-tmp /tmp`,
    ])

    await provider.start(runtime)
    expect(await provider.status(runtime)).toBe('running')
    const transport = await readyRuntime(runtime)
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
    const zombies = dockerText(
      'exec',
      containerName,
      'sh',
      '-c',
      '(sleep 0.2 &); sleep 1; grep -l "^State:[[:space:]]*Z" /proc/[0-9]*/status || true',
    )
    expect(zombies).toBe('')

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
  'two runtimes on one host cannot reach each other, while spyria-host relays to both',
  async () => {
    const { gateway, hostId, prefix, readyRuntime } = await dockerHost()
    const host = { workspaceId: acme, hostId }
    const provider = gateway.sandboxProvider
    const runtimes = ['isolated-a', 'isolated-b'].map((runtimeId) => ({ ...host, runtimeId }))
    for (const runtime of runtimes) {
      await provider.create({ ...runtime, image: spyriaImage })
      await provider.start(runtime)
    }
    for (const runtime of runtimes) await readyRuntime(runtime)
    const [first, second] = runtimes.map(({ runtimeId }) => `${prefix}rt-${runtimeId}`)
    expect(docker('exec', String(first), 'getent', 'hosts', String(second)).exitCode).not.toBe(0)
    expect(reaches(first, `http://${addressOf(first)}:8000/ready`)).toBe('reached')
    if (dockerOperatingSystem() === 'OrbStack')
      console.warn('OrbStack accepts traffic between Docker networks: the address check between runtimes is skipped')
    else expect(reaches(first, `http://${addressOf(second)}:8000/ready`)).toStartWith('blocked')
    for (const runtime of runtimes) await provider.remove(runtime)
  },
  90_000,
)

test.skipIf(!hasImage)(
  'a runtime reaches the internet and a port the machine publishes on every interface, but not one published on 127.0.0.1 nor a service on another Docker network',
  async () => {
    const { gateway, hostId, prefix, readyRuntime } = await dockerHost()
    const host = { workspaceId: acme, hostId }
    const provider = gateway.sandboxProvider
    const runtime = { ...host, runtimeId: 'reachability' }
    const runtimeContainer = `${prefix}rt-reachability`
    await provider.create({ ...runtime, image: spyriaImage })
    await provider.start(runtime)
    await readyRuntime(runtime)
    expect(reaches(runtimeContainer, 'https://example.com/')).toBe('reached')

    const service = `${prefix}service`
    const serviceNetwork = `${prefix}services-net`
    const freePorts = [
      Bun.serve({ port: 0, fetch: () => new Response() }),
      Bun.serve({ port: 0, fetch: () => new Response() }),
    ]
    const [loopbackPort, everyInterfacePort] = freePorts.map((server) => server.port)
    for (const server of freePorts) await server.stop(true)
    expect(docker('network', 'create', serviceNetwork).exitCode).toBe(0)
    const startedService = docker(
      ...['run', '-d', '--name', service, '--network', serviceNetwork],
      ...['-p', `127.0.0.1:${loopbackPort}:8080`, '-p', `${everyInterfacePort}:8080`],
      ...['--entrypoint', 'node', spyriaImage, '-e'],
      "require('node:http').createServer((request, response) => response.end('service')).listen(8080)",
    )
    expect(startedService.exitCode).toBe(0)
    const serviceAnswer = () =>
      fetch(`http://127.0.0.1:${loopbackPort}/`).then(
        (response) => response.text(),
        () => '',
      )
    await waitFor(async () => (await serviceAnswer()) === 'service')
    expect(reaches(service, `http://${addressOf(service)}:8080/`)).toBe('reached')
    const operatingSystem = dockerOperatingSystem()
    if (operatingSystem === 'OrbStack' || operatingSystem === 'Docker Desktop')
      console.warn(`${operatingSystem} forwards host.docker.internal to the machine's loopback: that check is skipped`)
    else {
      expect(reaches(runtimeContainer, `http://host.docker.internal:${everyInterfacePort}/`)).toBe('reached')
      expect(reaches(runtimeContainer, `http://host.docker.internal:${loopbackPort}/`)).toStartWith('blocked')
    }
    if (operatingSystem === 'OrbStack')
      console.warn('OrbStack accepts traffic between Docker networks: the address check of the service is skipped')
    else expect(reaches(runtimeContainer, `http://${addressOf(service)}:8080/`)).toStartWith('blocked')
    await provider.remove(runtime)
    docker('rm', '-f', service)
    docker('network', 'rm', serviceNetwork)
  },
  90_000,
)

test.skipIf(!hasImage)(
  "runtime jobs create, stop, resume with the same key and files, and remove a real runtime of Spyria's image; prepare refuses another image",
  async () => {
    const startedAt = performance.now()
    const { gateway, hostId, prefix } = await dockerHost()
    const host = { workspaceId: acme, hostId }
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
      const apiKey = gateway.sandboxProvider.apiKeyOf({ ...host, runtimeId: id })
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
    const { gateway, hostId, prefix, readyRuntime } = await dockerHost()
    const host = { workspaceId: acme, hostId }
    const provider = gateway.sandboxProvider
    const runtimes = ['cycle-a', 'cycle-b', 'cycle-c'].map((runtimeId) => ({ ...host, runtimeId }))
    const runtimeNetworks = () =>
      dockerText('network', 'ls', '--format', '{{.Name}}', '--filter', `name=^${prefix}rt-cycle-`)
        .split('\n')
        .filter(Boolean)
    for (const runtime of runtimes) {
      await provider.create({ ...runtime, image: spyriaImage })
      await provider.start(runtime)
    }
    for (const runtime of runtimes) await readyRuntime(runtime)
    expect(runtimeNetworks()).toHaveLength(3)
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const runtime of runtimes) await provider.stop(runtime)
      expect(runtimeNetworks()).toEqual([])
      for (const runtime of runtimes) await provider.start(runtime)
      expect(runtimeNetworks()).toHaveLength(3)
    }
    for (const runtime of runtimes) await readyRuntime(runtime)
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
    const { gateway, hostId, prefix } = await dockerHost()
    const host = { workspaceId: acme, hostId }
    const runtime = { ...host, runtimeId: 'orphaned' }
    const otherPrefix = `spyria-test-other-${crypto.randomUUID().slice(0, 8)}-`
    const otherObjects = { network: `${otherPrefix}rt-orphaned-net`, volume: `${otherPrefix}rt-orphaned-ws` }
    try {
      docker('network', 'create', '--label', 'spyria.managed=1', otherObjects.network)
      docker('volume', 'create', otherObjects.volume)
      await gateway.sandboxProvider.create({ ...runtime, image: spyriaImage })
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

test.skipIf(!hasImage)(
  'recreating a runtime replaces its container on the image given but keeps its volumes and the files in them',
  async () => {
    const { gateway, hostId, prefix } = await dockerHost()
    const provider = gateway.sandboxProvider
    const runtime = { workspaceId: acme, hostId, runtimeId: 'docker-recreate' }
    const containerName = `${prefix}rt-docker-recreate`
    const inWorkspaceVolume = (...command: string[]) =>
      dockerText(
        'run',
        '--rm',
        '-v',
        `${containerName}-ws:/workspace`,
        '--entrypoint',
        'sh',
        spyriaImage,
        '-c',
        ...command,
      )
    await provider.create({ ...runtime, image: spyriaImage })
    inWorkspaceVolume('echo kept > /workspace/kept.txt')
    const [before] = JSON.parse(dockerText('inspect', containerName))
    await provider.recreate({ ...runtime, image: spyriaImage })
    const [after] = JSON.parse(dockerText('inspect', containerName))
    expect(after.Id).not.toBe(before.Id)
    expect(after.Config.Labels).toMatchObject({ 'spyria.managed': '1', 'spyria.runtime': 'docker-recreate' })
    expect(inWorkspaceVolume('cat /workspace/kept.txt')).toBe('kept')
    await provider.remove(runtime)
    expect(await provider.status(runtime)).toBe('missing')
  },
  60_000,
)

test.skipIf(!hasImage)(
  'a snapshot copies a running runtime’s project and home into a volume that the next runtimes of the repository mount read-only, and pruning removes it once nothing uses it',
  async () => {
    const { gateway, hostId, prefix, readyRuntime } = await dockerHost()
    const host = { workspaceId: acme, hostId }
    const provider = gateway.sandboxProvider
    const setupSnapshot = { repository: 'acme/app', setupCommand: 'bun install' }
    const [source, reader] = ['snapshot-source', 'snapshot-reader'].map((runtimeId) => ({ ...host, runtimeId }))
    const started = async (runtime: typeof host & { runtimeId: string }) => {
      await provider.create({ ...runtime, image: spyriaImage, setupSnapshot })
      await provider.start(runtime)
      await readyRuntime(runtime)
      return `${prefix}rt-${runtime.runtimeId}`
    }
    if (!source || !reader) throw new Error('Two runtimes are needed')
    const sourceContainer = await started(source)
    docker(
      'exec',
      sourceContainer,
      'sh',
      '-c',
      'mkdir -p /workspace/project/node_modules && echo installed > /workspace/project/node_modules/dependency && echo tool > /home/spyria/tool',
    )
    await provider.snapshot({ ...source, setupSnapshot })
    expect(await provider.status(source)).toBe('running')
    expect(
      (await provider.connect(source).fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 })).status,
    ).toBe(200)
    const snapshots = dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}snapshot-`).split('\n')
    expect(snapshots).toHaveLength(1)

    const readerContainer = await started(reader)
    const read = (path: string) => dockerText('exec', readerContainer, 'cat', `/var/lib/spyria/snapshot/${path}`)
    expect(read('project/node_modules/dependency')).toBe('installed')
    expect(read('home/tool')).toBe('tool')
    expect(docker('exec', readerContainer, 'test', '-f', '/var/lib/spyria/snapshot/complete').exitCode).toBe(0)
    expect(docker('exec', readerContainer, 'touch', '/var/lib/spyria/snapshot/changed').exitCode).not.toBe(0)

    await provider.pruneSnapshots({ ...host, keep: [] })
    expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}snapshot-`)).toBe(snapshots[0] ?? '')
    for (const runtime of [source, reader]) await provider.remove(runtime)
    await provider.pruneSnapshots({ ...host, keep: [] })
    expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}snapshot-`)).toBe('')
  },
  120_000,
)
