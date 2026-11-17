import { afterAll, expect, test } from 'bun:test'
import { createTestDatabase, databaseDropTimeoutMilliseconds } from '@spyria/db/testing'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { startDockerTestHost } from '../testing/docker-runtime-host.ts'
import { pinnedPackagesOf, startFakeNpmRegistry } from '../testing/harnesses.ts'
import { acme, rejectionOf, waitFor } from '../testing/testing.ts'

const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  docker(...args)
    .stdout.toString()
    .trim()
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

const registry = startFakeNpmRegistry(pinnedPackagesOf('claude-code'))
const testDatabase = await createTestDatabase()
const { gateway, hostId, prefix, cleanup } = await startDockerTestHost({
  database: testDatabase.database,
  spyriaAgentImage: spyriaImage,
  personal: true,
  environment: { SPYRIA_HARNESS_REGISTRY: registry.url },
})
const harnessesVolume = `${prefix}harnesses`

afterAll(async () => {
  await cleanup()
  registry.stop()
  await testDatabase.drop()
}, databaseDropTimeoutMilliseconds)

const inVolume = (script: string) =>
  dockerText(
    ...['run', '--rm', '--user', '10001:10001', '--network', 'none', '--entrypoint', 'sh'],
    ...['--mount', `type=volume,src=${harnessesVolume},dst=/harnesses`, spyriaImage, '-c', script],
  )

test('a personal host installs a harness from the configured registry into its volume once, prunes older folders, mounts it read-only into the session and reports an npm failure', async () => {
  const runtime = { workspaceId: acme, hostId, runtimeId: 'harness-install' }
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
