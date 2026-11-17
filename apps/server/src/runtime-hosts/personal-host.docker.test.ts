import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { harnesses } from '@spyria/kernel'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { startDockerTestHost } from '../testing/docker-runtime-host.ts'
import { requireTestHarnesses, testHarnessesVolume } from '../testing/harnesses.ts'
import { acme, rejectionOf, waitFor } from '../testing/testing.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')
requireTestHarnesses()

const testDatabase = await createTestDatabase()
const { gateway, hostId, prefix, readyRuntime, cleanup } = await startDockerTestHost({
  database: testDatabase.database,
  spyriaAgentImage: spyriaImage,
  personal: true,
  environment: {
    SPYRIA_HOST_HEARTBEAT_MS: '200',
    SPYRIA_HARNESSES_VOLUME: testHarnessesVolume,
    SPYRIA_HARNESS_REGISTRY: 'http://127.0.0.1:9',
  },
})

afterAll(async () => {
  await cleanup()
  await testDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const hostRow = async (id: string) =>
  (await testDatabase.database.$client`select status, capacity from runtime_hosts where id = ${id}`)[0]

test("a real spyria-host --personal runs Spyria's image with the credentials volume, relays only spyria-agent's routes, lists the real adapter models without a login and reports the sign-in", async () => {
  expect((await hostRow(hostId))?.capacity).toMatchObject({ personal: true, signedIn: [] })

  const host = { workspaceId: acme, hostId }
  await gateway.prepare(host, spyriaImage)
  const runtime = { ...host, runtimeId: 'personal-smoke' }
  const apiKey = gateway.sandboxProvider.apiKeyOf(runtime)
  const containerName = `${prefix}rt-personal-smoke`
  await gateway.sandboxProvider.create({ ...runtime, image: spyriaImage })
  const [inspected] = JSON.parse(dockerText('inspect', containerName))
  expect(
    (inspected.HostConfig.Mounts as { Source: string; Target: string }[]).map(({ Source, Target }) => [Source, Target]),
  ).toContainEqual([`${prefix}cred-claude-code`, '/home/spyria/.claude'])
  await gateway.sandboxProvider.start(runtime)
  const transport = await readyRuntime(runtime)
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
  const claude = await startSession([...harnesses['claude-code'].launch])
  expect(claude.sessionUpdate).toBe('session_started')
  expect(() => JSON.parse(dockerText('exec', containerName, 'cat', '/home/spyria/.claude.json'))).not.toThrow()
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

  expect(dockerText('exec', containerName, 'cat', '/home/spyria/.claude/.credentials.json')).toBe(credentialsFile)
  const download = await rejectionOf(
    transport.fetch({
      method: 'GET',
      path: '/api/file/download?path=/home/spyria/.claude/.credentials.json',
      headers,
    }),
  )
  expect(download.message).toContain('refused')
  const command = await rejectionOf(
    transport.fetch({
      method: 'POST',
      path: '/api/bash/execute_bash_command',
      headers,
      body: JSON.stringify({ command: 'cat /home/spyria/.claude/.credentials.json' }),
    }),
  )
  expect(command.message).toContain('refused')

  await gateway.sandboxProvider.remove(runtime)
  expect(dockerText('volume', 'ls', '-q', '--filter', `name=^${prefix}cred-claude-code$`)).toBe(
    `${prefix}cred-claude-code`,
  )

  await waitFor(
    async () =>
      ((await hostRow(hostId))?.capacity as { signedIn?: string[] } | undefined)?.signedIn?.includes('claude-code') ===
      true,
  )
  expect((await hostRow(hostId))?.capacity).toMatchObject({ personal: true, signedIn: ['claude-code'] })
}, 180_000)
