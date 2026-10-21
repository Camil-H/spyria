import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDocker } from './docker.ts'

const directory = mkdtempSync(join(tmpdir(), 'spyria-docker-'))
const socketPath = join(directory, 'docker.sock')
const hungDaemon = Bun.serve({
  unix: socketPath,
  fetch: (request): Response | Promise<Response> =>
    new URL(request.url).pathname === '/_ping' ? new Response('OK') : new Promise(() => {}),
})
afterAll(() => {
  void hungDaemon.stop(true)
  rmSync(directory, { recursive: true, force: true })
})

test('a Docker call that gets no answer fails after its timeout, the default one or its own', async () => {
  const docker = createDocker(socketPath, 50)
  expect(await docker<string>('GET', '/_ping')).toBe('OK')
  const startedAt = performance.now()
  await expect(docker('GET', '/containers/json')).rejects.toThrow()
  expect(performance.now() - startedAt).toBeLessThan(2_000)
  const longerStartedAt = performance.now()
  await expect(docker('POST', '/containers/install/wait', undefined, 200)).rejects.toThrow()
  expect(performance.now() - longerStartedAt).toBeGreaterThanOrEqual(150)
})
