import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@hq/db/testing'
import { runtimeHostId } from '@hq/kernel'
import { agentServerImage } from '@hq/runtime/server'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { acme, aliceInAcme, openSharedTestApp, sessionTokenOf, testAuthSettings, waitFor } from '../testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const hasImage = docker('info').exitCode === 0 && docker('image', 'inspect', agentServerImage).exitCode === 0
if (!hasImage)
  console.warn('Skipping the personal host Docker test: Docker or the pinned Agent Server image is missing')

const prefix = `hq-test-${crypto.randomUUID().slice(0, 8)}-`
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const stateDirectory = mkdtempSync(join(tmpdir(), 'hq-test-host-'))
await openSharedTestApp()
const testDatabase = await createTestDatabase()
const gateway = createRuntimeHostGateway({ databases: () => [testDatabase.database] })
const app = createApp({ database: testDatabase.database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
let hostProcess: ReturnType<typeof Bun.spawn> | undefined

const removeDockerObjects = () => {
  for (const [kind, remove] of [
    ['ps -aq', 'rm -f'],
    ['volume ls -q', 'volume rm -f'],
    ['network ls -q', 'network rm'],
  ] as const) {
    const names = dockerText(...kind.split(' '), '--filter', `name=^${prefix}`)
      .split('\n')
      .filter(Boolean)
    if (names.length > 0) docker(...remove.split(' '), ...names)
  }
}

afterAll(async () => {
  hostProcess?.kill()
  await hostProcess?.exited
  if (hasImage) removeDockerObjects()
  void server.stop(true)
  await testDatabase.drop()
  rmSync(stateDirectory, { recursive: true, force: true })
}, databaseDropTimeoutMilliseconds)

const hostRow = async (id: string) =>
  (await testDatabase.database.$client`select status, capacity from runtime_hosts where id = ${id}`)[0]
const startPersonalHost = async (id: string, url: string) => {
  hostProcess = Bun.spawn(['bun', hostProgram, '--personal', url], {
    env: { ...process.env, HQ_HOST_STATE_DIR: stateDirectory, HQ_HOST_PREFIX: prefix },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitFor(async () => (await hostRow(id))?.status === 'online', 30_000)
}
const stopHost = async (id: string) => {
  hostProcess?.kill()
  await hostProcess?.exited
  await waitFor(async () => (await hostRow(id))?.status !== 'online', 30_000)
}

test.skipIf(!hasImage)(
  'a real hq-host --personal mounts the credentials volume, relays only the allowlist and reports the sign-in',
  async () => {
    const added = await app.request('/api/runtime-hosts', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await sessionTokenOf(testDatabase.database, acme, aliceInAcme.userId)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ personal: true }),
    })
    const { id, code } = (await added.json()) as { id: string; code: string }
    const claimUrl = `http://localhost:${server.port}/h/${code}`
    await startPersonalHost(id, claimUrl)
    expect((await hostRow(id))?.capacity).toMatchObject({ personal: true, signedIn: [] })

    const host = { workspaceId: acme, hostId: runtimeHostId(id) }
    await gateway.prepare(host, agentServerImage)
    const credentialsFile = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-FAKEACCESS-smoke', refreshToken: 'sk-ant-ort01-FAKEREFRESH-smoke' },
    })
    const written = docker(
      ...['run', '--rm', '--name', `${prefix}write-credentials`, '--user', '10001:10001', '--network', 'none'],
      ...['--mount', `type=volume,src=${prefix}cred-claude,dst=/c`, '--entrypoint', 'sh', agentServerImage],
      ...['-c', `umask 077 && printf '%s' '${credentialsFile}' > /c/.credentials.json`],
    )
    expect(written.stderr.toString()).toBe('')

    const runtime = { ...host, runtimeId: 'personal-smoke' }
    const apiKey = 'test-api-key-0123456789abcdef'
    const containerName = `${prefix}rt-personal-smoke`
    await gateway.sandboxProvider.create({ ...runtime, image: agentServerImage, apiKey })
    const [inspected] = JSON.parse(dockerText('inspect', containerName))
    expect(
      (inspected.HostConfig.Mounts as { Source: string; Target: string }[]).map(({ Source, Target }) => [
        Source,
        Target,
      ]),
    ).toContainEqual([`${prefix}cred-claude`, '/home/openhands/.claude'])
    await gateway.sandboxProvider.start(runtime)
    const transport = gateway.sandboxProvider.connect(runtime)
    const isReady = () =>
      transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
        (response) => response.status === 200,
        () => false,
      )
    for (const deadline = Date.now() + 30_000; !(await isReady()); await Bun.sleep(100))
      if (Date.now() > deadline) throw new Error('The Agent Server was not ready within 30 s')
    expect(dockerText('exec', containerName, 'cat', '/home/openhands/.claude/.credentials.json')).toBe(credentialsFile)

    const headers = { 'x-session-api-key': apiKey, 'content-type': 'application/json' }
    await expect(
      transport.fetch({
        method: 'GET',
        path: '/api/file/download?path=/home/openhands/.claude/.credentials.json',
        headers,
      }),
    ).rejects.toThrow('refused')
    await expect(
      transport.fetch({
        method: 'POST',
        path: '/api/bash/execute_bash_command',
        headers,
        body: JSON.stringify({ command: 'cat /home/openhands/.claude/.credentials.json' }),
      }),
    ).rejects.toThrow('refused')

    const created = await transport.fetch({
      method: 'POST',
      path: '/api/conversations',
      headers,
      body: JSON.stringify({
        agent: {
          kind: 'Agent',
          llm: { model: 'openai/never-called', api_key: 'unused', base_url: 'http://127.0.0.1:9/v1' },
          tools: [],
        },
        workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
        autotitle: false,
      }),
    })
    expect(created.status).toBe(201)
    const conversationId = String(JSON.parse(created.body).id)
    expect(
      (await transport.fetch({ method: 'GET', path: `/api/conversations/${conversationId}`, headers })).status,
    ).toBe(200)
    expect(
      (await transport.fetch({ method: 'DELETE', path: `/api/conversations/${conversationId}`, headers })).status,
    ).toBe(200)

    await gateway.sandboxProvider.remove(runtime)
    expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}cred-claude$`)).toBe(`${prefix}cred-claude`)

    await stopHost(id)
    await startPersonalHost(id, claimUrl)
    expect((await hostRow(id))?.capacity).toMatchObject({ personal: true, signedIn: ['claude'] })
  },
  180_000,
)
