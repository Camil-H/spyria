import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase } from '@hq/db/testing'
import { runtimeHostId } from '@hq/kernel'
import { agentServerImage } from '@hq/runtime/server'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { acme, aliceInAcme, sessionTokenOf, testAuthSettings, waitFor } from '../testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const hasDocker = docker('info').exitCode === 0
const hasImage = hasDocker && docker('image', 'inspect', agentServerImage).exitCode === 0
const skipReason = !hasDocker
  ? 'Docker is unavailable'
  : `the Agent Server image is not pulled (docker pull ${agentServerImage})`
if (!hasImage) console.warn(`Skipping the runtime host Docker test: ${skipReason}`)

const prefix = `hq-test-${crypto.randomUUID().slice(0, 8)}-`
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const stateDirectory = mkdtempSync(join(tmpdir(), 'hq-test-host-'))
const testDatabase = await createTestDatabase()
const gateway = createRuntimeHostGateway({ databases: () => [testDatabase.database] })
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
})

test.skipIf(!hasImage)(
  'hq-host creates a hardened Agent Server, relays HTTP to it, then stops and removes it with its volumes',
  async () => {
    const startedAt = performance.now()
    const added = await app.request('/api/runtime-hosts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sessionTokenOf(testDatabase.database, acme, aliceInAcme.userId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Docker test host' }),
    })
    const { id, code } = (await added.json()) as { id: string; code: string }
    hostProcess = Bun.spawn(['bun', hostProgram, `http://localhost:${server.port}/h/${code}`], {
      env: { ...process.env, HQ_HOST_STATE_DIR: stateDirectory, HQ_HOST_PREFIX: prefix },
      stdout: 'inherit',
      stderr: 'inherit',
    })
    await waitFor(
      async () =>
        (await testDatabase.database.$client`select status from runtime_hosts where id = ${id}`)[0]?.status ===
        'online',
    )

    const provider = gateway.sandboxProvider
    const runtime = { workspaceId: acme, hostId: runtimeHostId(id), runtimeId: 'docker-test' }
    const apiKey = 'test-api-key-0123456789abcdef'
    const containerName = `${prefix}rt-docker-test`
    await expect(provider.create({ ...runtime, image: 'docker.io/library/alpine:3', apiKey })).rejects.toThrow(
      'refused',
    )
    await provider.create({ ...runtime, image: agentServerImage, apiKey })
    expect(await provider.status(runtime)).toBe('stopped')

    const [inspected] = JSON.parse(dockerText('inspect', containerName))
    expect(inspected.Config.User).toBe('10001:10001')
    expect(inspected.Config.Labels).toMatchObject({ 'hq.managed': '1', 'hq.runtime': 'docker-test' })
    expect(inspected.HostConfig).toMatchObject({
      NetworkMode: `${prefix}runtimes`,
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
      if (Date.now() > deadline) throw new Error('The Agent Server was not ready within 30 s')
    const unauthenticated = await transport.fetch({ method: 'GET', path: '/api/conversations/search' })
    expect(unauthenticated.status).toBe(401)
    const authenticated = await transport.fetch({
      method: 'GET',
      path: '/api/conversations/search',
      headers: { 'x-session-api-key': apiKey },
    })
    expect(authenticated.status).toBe(200)
    expect(JSON.parse(authenticated.body)).toHaveProperty('items')
    await expect(transport.fetch({ method: 'GET', path: '@169.254.169.254/' })).rejects.toThrow('refused')

    await provider.stop(runtime)
    expect(await provider.status(runtime)).toBe('stopped')
    await provider.remove(runtime)
    expect(await provider.status(runtime)).toBe('missing')
    expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${containerName}`)).toBe('')
    console.info(`Runtime host Docker test took ${Math.round(performance.now() - startedAt)} ms`)
  },
  60_000,
)
