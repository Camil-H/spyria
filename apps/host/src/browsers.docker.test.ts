import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { attachToBrowser, browserContainerOf, profileVolumeOf } from './browsers.ts'
import { createCommandRunner } from './commands.ts'
import { createDocker } from './docker.ts'
import { waitFor } from './testing.ts'

setDefaultTimeout(300_000)
const dockerCli = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const dockerText = (...args: string[]) =>
  dockerCli(...args)
    .stdout.toString()
    .trim()
const image =
  process.env.SPYRIA_AGENT_IMAGE ||
  (
    await Bun.file(new URL('../../agent/image-id', import.meta.url))
      .text()
      .catch(() => '')
  ).trim()
if (!image || dockerCli('image', 'inspect', image).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

const socketPath = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock'
const prefix = `spyria-test-${crypto.randomUUID().slice(0, 8)}-`
const runtimeId = 'browser-runtime'
const browserKey = 'b'.repeat(32)
const runtimeName = `${prefix}rt-${runtimeId}`
const browserName = browserContainerOf(runtimeName, browserKey)
const runner = createCommandRunner({ docker: createDocker(socketPath, 120_000), prefix })
afterAll(async () => {
  await runner.run({ op: 'remove', runtimeId }).catch(() => {})
})

const settings = {
  blockInternalNetworks: true,
  allowedInternalAddresses: [],
  allowedSites: [],
  blockedSites: ['blocked.example.com'],
  downloads: true,
  uploads: true,
}
const browserSession = async () => {
  const lines: Record<string, unknown>[] = []
  const stream = await attachToBrowser(socketPath, browserName, {
    onLine: (line) => lines.push(JSON.parse(line)),
    onClose: () => {},
  })
  let nextId = 1
  const answerOf = async (command: object) => {
    const id = nextId++
    stream.send(JSON.stringify({ ...command, id }))
    await waitFor(() => lines.some((line) => line.id === id))
    const answer = lines.find((line) => line.id === id)
    return answer?.error === undefined ? { result: answer?.result } : { error: answer.error }
  }
  return { lines, stream, answerOf }
}

test("a member's browser runs the runtime image beside the runtime, reaches the runtime's own server as localhost, refuses internal networks and blocked sites, and leaves the runtime no way into its display, processes or a debugging port", async () => {
  await runner.run({ op: 'create', runtimeId, image, apiKey: 'k'.repeat(32) })
  await runner.run({ op: 'start', runtimeId })
  await runner.run({ op: 'browser_start', runtimeId, browserKey })
  expect(dockerText('inspect', '-f', '{{.HostConfig.NetworkMode}}', browserName)).toBe(
    `container:${dockerText('inspect', '-f', '{{.Id}}', runtimeName)}`,
  )

  const { lines, stream, answerOf } = await browserSession()
  stream.send(JSON.stringify({ type: 'settings', settings }))
  for (const deadline = Date.now() + 60_000; !lines.some((line) => line.type === 'ready'); ) {
    if (Date.now() > deadline) throw new Error(`The browser never got ready: ${JSON.stringify(lines)}`)
    await Bun.sleep(100)
  }

  let opened = await answerOf({ command: 'open', url: 'http://localhost:8000/ready' })
  for (const deadline = Date.now() + 30_000; 'error' in opened && Date.now() < deadline; await Bun.sleep(500))
    opened = await answerOf({ command: 'open', url: 'http://localhost:8000/ready' })
  expect(opened).toEqual({ result: expect.stringContaining('(http://localhost:8000/ready)') })
  expect(lines).toContainEqual({ type: 'visited', url: 'http://localhost:8000/ready' })
  expect(await answerOf({ command: 'evaluate', expression: 'navigator.userAgent.includes("Headless")' })).toEqual({
    result: 'false',
  })
  expect(await answerOf({ command: 'open', url: 'http://169.254.169.254/latest/meta-data' })).toEqual({
    error: '169.254.169.254 is on an internal network your workspace blocks',
  })
  expect(await answerOf({ command: 'open', url: 'https://blocked.example.com/' })).toEqual({
    error: 'blocked.example.com is a site your workspace blocks',
  })
  stream.send(JSON.stringify({ type: 'watch' }))
  await waitFor(() => lines.some((line) => line.type === 'frame'))

  const inRuntime = (command: string) => dockerText('exec', runtimeName, 'sh', '-c', command)
  expect(inRuntime('cat /proc/net/unix')).not.toContain('X11')
  expect(inRuntime('cat /proc/[0-9]*/cmdline 2>/dev/null | tr "\\0" " "')).not.toContain('chrom')
  const listeningPorts = inRuntime('awk \'FNR > 1 && $4 == "0A" { print $2 }\' /proc/net/tcp /proc/net/tcp6')
    .split('\n')
    .map((address) => Number.parseInt(address.split(':').at(-1) ?? '', 16))
  expect(listeningPorts).toContain(8000)
  expect(new Set(listeningPorts.filter((port) => port !== 8000)).size).toBe(1)
  expect(inRuntime('ls /var/lib/spyria/browser 2>&1 || true')).not.toContain('profile')
  stream.close()

  await runner.run({ op: 'browser_stop', runtimeId, browserKey })
  expect(dockerText('inspect', '-f', '{{.State.Running}}', browserName)).toBe('false')
  await runner.run({ op: 'stop', runtimeId })
  expect(dockerCli('inspect', browserName).exitCode).not.toBe(0)
  expect(dockerCli('volume', 'inspect', profileVolumeOf(browserName)).exitCode).not.toBe(0)
})
