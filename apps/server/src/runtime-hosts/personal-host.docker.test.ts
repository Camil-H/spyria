import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { runtimeHostId } from '@spyria/kernel'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { requireTestHarnesses, testHarnessesVolume } from '../testing/harnesses.ts'
import {
  acme,
  aliceInAcme,
  rejectionOf,
  sessionTokenOf,
  testAuthSettings,
  testSecretsKey,
  waitFor,
} from '../testing/testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')
requireTestHarnesses()

const deployment = `spyria-test-${crypto.randomUUID().slice(0, 8)}`
const prefix = `${deployment}-`
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const stateDirectory = mkdtempSync(join(tmpdir(), 'spyria-test-host-'))
const testDatabase = await createTestDatabase()
const gateway = createRuntimeHostGateway({
  runtimeKeySecret: testSecretsKey,
  databases: () => [testDatabase.database],
  spyriaAgentImage: spyriaImage,
})
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
  removeDockerObjects()
  void server.stop(true)
  await testDatabase.drop()
  rmSync(stateDirectory, { recursive: true, force: true })
}, databaseDropTimeoutMilliseconds)

const hostRow = async (id: string) =>
  (await testDatabase.database.$client`select status, capacity from runtime_hosts where id = ${id}`)[0]
const startPersonalHost = async (id: string, url: string) => {
  hostProcess = Bun.spawn([process.execPath, hostProgram, '--personal', url], {
    env: {
      ...process.env,
      SPYRIA_HOST_STATE_DIR: stateDirectory,
      SPYRIA_DEPLOYMENT: deployment,
      SPYRIA_HOST_HEARTBEAT_MS: '200',
      SPYRIA_HARNESSES_VOLUME: testHarnessesVolume,
      SPYRIA_HARNESS_REGISTRY: 'http://127.0.0.1:9',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitFor(async () => (await hostRow(id))?.status === 'online', 30_000)
}

test("a real spyria-host --personal runs Spyria's image with the credentials volume, relays only spyria-agent's routes, lists the real adapter models without a login and reports the sign-in", async () => {
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
  await gateway.prepare(host, spyriaImage)
  const runtime = { ...host, runtimeId: 'personal-smoke' }
  const apiKey = gateway.sandboxProvider.apiKeyOf(runtime)
  const containerName = `${prefix}rt-personal-smoke`
  await gateway.sandboxProvider.create({ ...runtime, image: spyriaImage })
  const [inspected] = JSON.parse(dockerText('inspect', containerName))
  expect(
    (inspected.HostConfig.Mounts as { Source: string; Target: string }[]).map(({ Source, Target }) => [Source, Target]),
  ).toContainEqual([`${prefix}cred-claude-code`, '/home/openhands/.claude'])
  await gateway.sandboxProvider.start(runtime)
  const transport = gateway.sandboxProvider.connect(runtime)
  const isReady = () =>
    transport.fetch({ method: 'GET', path: '/ready', timeoutMilliseconds: 1000 }).then(
      (response) => response.status === 200,
      () => false,
    )
  for (const deadline = Date.now() + 30_000; !(await isReady()); await Bun.sleep(100))
    if (Date.now() > deadline) throw new Error('spyria-agent was not ready within 30 s')
  const headers = { 'x-session-api-key': apiKey, 'content-type': 'application/json' }
  const startSession = async (command: string[]) => {
    const created = await transport.fetch({
      method: 'POST',
      path: '/api/conversations',
      headers,
      body: JSON.stringify({
        agent: { acp_command: command },
        workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
        secrets: {},
      }),
    })
    expect(created.status).toBe(201)
    const conversationId = String(JSON.parse(created.body).id)
    const started = Promise.withResolvers<{
      sessionUpdate: string
      message?: string
      configOptions?: { id: string; options: { name: string }[] }[]
    }>()
    const socket = transport.openSocket(`/sockets/events/${conversationId}`, {
      onOpen: () => socket.send(JSON.stringify({ type: 'auth', session_api_key: apiKey })),
      onMessage: (data) => {
        const { update } = JSON.parse(data)
        if (['session_started', 'error'].includes(update?.sessionUpdate)) started.resolve(update)
      },
      onClose: () => {},
    })
    const update = await started.promise
    socket.close()
    await transport.fetch({ method: 'DELETE', path: `/api/conversations/${conversationId}`, headers })
    return update
  }
  const claude = await startSession([
    ...['env', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1'],
    ...['CLAUDE_CODE_MAX_RETRIES=0', 'claude-agent-acp'],
  ])
  expect(claude.sessionUpdate).toBe('session_started')
  const models = claude.configOptions?.find((option) => option.id === 'model')?.options ?? []
  expect(models.map((model) => model.name)).toContain('Fable 5.1')
  expect(await startSession(['codex-acp'])).toMatchObject({
    sessionUpdate: 'error',
    message: 'Authentication required',
  })

  const credentialsFile = JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-FAKEACCESS-smoke', refreshToken: 'sk-ant-ort01-FAKEREFRESH-smoke' },
  })
  const written = docker(
    ...['run', '--rm', '--name', `${prefix}write-credentials`, '--user', '10001:10001', '--network', 'none'],
    ...['--mount', `type=volume,src=${prefix}cred-claude-code,dst=/c`, '--entrypoint', 'sh', spyriaImage],
    ...['-c', `umask 077 && printf '%s' '${credentialsFile}' > /c/.credentials.json`],
  )
  expect(written.stderr.toString()).toBe('')

  expect(dockerText('exec', containerName, 'cat', '/home/openhands/.claude/.credentials.json')).toBe(credentialsFile)
  const download = await rejectionOf(
    transport.fetch({
      method: 'GET',
      path: '/api/file/download?path=/home/openhands/.claude/.credentials.json',
      headers,
    }),
  )
  expect(download.message).toContain('refused')
  const command = await rejectionOf(
    transport.fetch({
      method: 'POST',
      path: '/api/bash/execute_bash_command',
      headers,
      body: JSON.stringify({ command: 'cat /home/openhands/.claude/.credentials.json' }),
    }),
  )
  expect(command.message).toContain('refused')

  await gateway.sandboxProvider.remove(runtime)
  expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}cred-claude-code$`)).toBe(
    `${prefix}cred-claude-code`,
  )

  await waitFor(
    async () =>
      ((await hostRow(id))?.capacity as { signedIn?: string[] } | undefined)?.signedIn?.includes('claude-code') ===
      true,
  )
  expect((await hostRow(id))?.capacity).toMatchObject({ personal: true, signedIn: ['claude-code'] })
}, 180_000)
