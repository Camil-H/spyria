import { expect, test } from 'bun:test'
import { app } from './app.ts'

const contextCores = ['@hq/workspace/core', '@hq/conversation/core', '@hq/profile/core', '@hq/panel/core']

test('serves health', async () => {
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const response = await fetch(new URL('/health', server.url))
  await server.stop()
  expect(await response.json()).toEqual({ status: 'ok' })
})

test('loads every context core without React or client code', async () => {
  for (const contextCore of contextCores) expect(Object.keys(await import(contextCore)).length).toBeGreaterThan(0)
  const build = await Bun.build({
    entrypoints: contextCores.map((contextCore) => Bun.resolveSync(contextCore, import.meta.dir)),
    target: 'bun',
    metafile: true,
  })
  const loadedModules = Object.keys(build.metafile?.inputs ?? {})
  expect(loadedModules.length).toBeGreaterThan(contextCores.length)
  expect(
    loadedModules.filter((path) =>
      /(^|\/)(node_modules\/(react|react-dom|react-router)|packages\/(ui|session)|entrypoints)\//.test(path),
    ),
  ).toEqual([])
})
