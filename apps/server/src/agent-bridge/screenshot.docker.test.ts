import { afterAll, expect, setDefaultTimeout, test } from 'bun:test'
import { readSpyriaAgentImage } from '../spyria-agent-image.ts'
import { waitFor } from '../testing/testing.ts'

setDefaultTimeout(300_000)
const docker = (...args: string[]) => Bun.spawnSync(['docker', ...args], { stderr: 'pipe' })
const spyriaImage = await readSpyriaAgentImage()
if (!spyriaImage || docker('image', 'inspect', spyriaImage).exitCode !== 0)
  throw new Error('Spyria image missing: run bun run agent:build')

const container = `spyria-test-screenshot-${crypto.randomUUID().slice(0, 8)}`
const volumes = { ws: '/workspace', home: '/home/openhands', tmp: '/tmp' }
const apiKey = crypto.randomUUID()
afterAll(() => {
  docker('rm', '-fv', container)
  docker('volume', 'rm', '-f', ...Object.keys(volumes).map((suffix) => `${container}-${suffix}`))
})

test('in the runtime image, run with a runtime’s limits, spyria-agent saves a PNG of a page served inside the runtime with the Chromium the image holds', async () => {
  const started = docker(
    ...['run', '-d', '--name', container, '--user', '10001:10001', '--read-only', '--cap-drop', 'ALL'],
    ...['--security-opt', 'no-new-privileges', '--memory', '2g', '--pids-limit', '512'],
    ...Object.entries(volumes).flatMap(([suffix, target]) => ['-v', `${container}-${suffix}:${target}`]),
    ...['-e', `OH_SESSION_API_KEYS_0=${apiKey}`, '-p', '127.0.0.1::8000', spyriaImage],
  )
  expect(started.stderr.toString()).toBe('')
  const port = docker('port', container, '8000').stdout.toString().trim().split(':').at(-1)
  const call = async (method: string, path: string, body?: object) =>
    (
      await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'x-session-api-key': apiKey, 'content-type': 'application/json' },
        body: body && JSON.stringify(body),
      })
    ).json() as Promise<Record<string, unknown>>
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/ready`).catch(() => undefined))?.ok === true)

  const request = { url: 'http://localhost:8000/ready', viewport: 'mobile', fullPage: false, theme: 'dark' }
  const sizeOf = async (fields: object) => {
    const taken = await call('POST', '/api/workspace/screenshot', { ...request, ...fields })
    const { content } = await call('GET', `/api/workspace/media?${new URLSearchParams({ path: String(taken.path) })}`)
    const png = Buffer.from(String(content), 'base64')
    return { path: taken.path, type: png.subarray(1, 4).toString(), size: [png.readUInt32BE(16), png.readUInt32BE(20)] }
  }
  expect(await sizeOf({ name: 'phone' })).toEqual({
    path: '.spyria/screenshots/phone.png',
    type: 'PNG',
    size: [390, 844],
  })
  expect(await sizeOf({ name: 'desktop', viewport: 'desktop', fullPage: true })).toEqual({
    path: '.spyria/screenshots/desktop.png',
    type: 'PNG',
    size: [1280, 800],
  })
  expect(
    await call('POST', '/api/workspace/screenshot', { ...request, name: 'down', url: 'http://localhost:9/' }),
  ).toEqual({
    error:
      'The screenshot of http://localhost:9/ failed: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:9/',
  })
})
