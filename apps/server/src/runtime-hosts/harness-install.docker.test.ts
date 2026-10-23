import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { runtimeHostId } from '@spyria/kernel'
import { websocket } from 'hono/bun'
import { createApp } from '../app.ts'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { pinnedPackagesOf, startFakeNpmRegistry } from '../testing/harnesses.ts'
import { acme, aliceInAcme, rejectionOf, sessionTokenOf, testAuthSettings, waitFor } from '../testing/testing.ts'
import { createRuntimeHostGateway } from './gateway.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

const deployment = `spyria-test-${crypto.randomUUID().slice(0, 8)}`
const prefix = `${deployment}-`
const harnessesVolume = `${prefix}harnesses`
const registry = startFakeNpmRegistry(pinnedPackagesOf('claude-code'))
const hostProgram = new URL('../../../host/src/main.ts', import.meta.url).pathname
const stateDirectory = mkdtempSync(join(tmpdir(), 'spyria-test-host-'))
const testDatabase = await createTestDatabase()
const gateway = createRuntimeHostGateway({
  runtimeKeySecret: testAuthSettings.tokenSecret,
  databases: () => [testDatabase.database],
  spyriaAgentImage: spyriaImage,
})
const app = createApp({ database: testDatabase.database, ...testAuthSettings, runtimeHosts: gateway })
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
let hostProcess: ReturnType<typeof Bun.spawn> | undefined

afterAll(async () => {
  hostProcess?.kill()
  await hostProcess?.exited
  for (const [list, remove] of [
    ['ps -aq', 'rm -f'],
    ['volume ls -q', 'volume rm -f'],
    ['network ls -q', 'network rm'],
  ] as const) {
    const names = dockerText(...list.split(' '), '--filter', `name=^${prefix}`)
      .split('\n')
      .filter(Boolean)
    if (names.length > 0) docker(...remove.split(' '), ...names)
  }
  registry.stop()
  void server.stop(true)
  await testDatabase.drop()
  rmSync(stateDirectory, { recursive: true, force: true })
}, databaseDropTimeoutMilliseconds)

const inVolume = (script: string) =>
  dockerText(
    ...['run', '--rm', '--user', '10001:10001', '--network', 'none', '--entrypoint', 'sh'],
    ...['--mount', `type=volume,src=${harnessesVolume},dst=/harnesses`, spyriaImage, '-c', script],
  )

test('a personal host installs a harness from the configured registry into its volume once, prunes older folders, mounts it read-only into the session and reports an npm failure', async () => {
  const added = await app.request('/api/runtime-hosts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await sessionTokenOf(testDatabase.database, acme, aliceInAcme.userId)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ personal: true }),
  })
  const { id, code } = (await added.json()) as { id: string; code: string }
  hostProcess = Bun.spawn([process.execPath, hostProgram, '--personal', `http://localhost:${server.port}/h/${code}`], {
    env: {
      ...process.env,
      SPYRIA_HOST_STATE_DIR: stateDirectory,
      SPYRIA_DEPLOYMENT: deployment,
      SPYRIA_HARNESS_REGISTRY: registry.url,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  await waitFor(
    async () =>
      (await testDatabase.database.$client`select status from runtime_hosts where id = ${id}`)[0]?.status === 'online',
    30_000,
  )
  const runtime = { workspaceId: acme, hostId: runtimeHostId(id), runtimeId: 'harness-install' }
  await gateway.prepare(runtime, spyriaImage)
  await gateway.sandboxProvider.create({ ...runtime, image: spyriaImage })
  const [inspected] = JSON.parse(dockerText('inspect', `${prefix}rt-harness-install`))
  expect(inspected.HostConfig.Mounts).toContainEqual(
    expect.objectContaining({ Source: harnessesVolume, Target: '/harnesses', ReadOnly: true }),
  )
  expect(inspected.Config.Env).toContain('CLAUDE_CODE_EXECUTABLE=/harnesses/claude-code/current/bin/claude')

  inVolume('mkdir -p /harnesses/claude-code/0123456789ab && touch /harnesses/claude-code/0123456789ab/.installed')
  expect(await gateway.sandboxProvider.hasHarness({ ...runtime, harness: 'claude-code' })).toBe(false)
  await gateway.sandboxProvider.installHarness({ ...runtime, harness: 'claude-code' })
  expect(await gateway.sandboxProvider.hasHarness({ ...runtime, harness: 'claude-code' })).toBe(true)
  const folders = inVolume('ls /harnesses/claude-code').split('\n')
  expect(folders.toSorted()).toEqual([inVolume('readlink /harnesses/claude-code/current'), 'current'].toSorted())
  expect(folders).not.toContain('0123456789ab')
  expect(registry.requested).toContain('@anthropic-ai/claude-code')

  await gateway.sandboxProvider.start(runtime)
  await waitFor(async () => {
    const [ready] = dockerText('exec', `${prefix}rt-harness-install`, 'sh', '-c', 'command -v claude-agent-acp').split(
      '\n',
    )
    return ready === '/harnesses/claude-code/current/bin/claude-agent-acp'
  }, 30_000)
  expect(
    dockerText('exec', `${prefix}rt-harness-install`, 'sh', '-c', 'touch /harnesses/x 2>&1 || echo read-only'),
  ).toContain('read-only')

  const failed = gateway.sandboxProvider.installHarness({ ...runtime, harness: 'codex' })
  expect((await rejectionOf(failed)).message).toMatch(
    /^code E404\n404 Not Found - GET http:\/\/host\.docker\.internal:\d+\/@\w+%2fcodex/,
  )
  expect(await gateway.sandboxProvider.hasHarness({ ...runtime, harness: 'codex' })).toBe(false)
  expect(dockerText('ps', '-aq', '--filter', `name=^${prefix}harness-install-`)).toBe('')
}, 240_000)
