import { expect, test } from 'bun:test'
import { app } from './app.ts'

const contextServerEntries = [
  '@hq/workspace/server',
  '@hq/conversation/server',
  '@hq/profile/server',
  '@hq/panel/server',
]

test('serves health', async () => {
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const response = await fetch(new URL('/health', server.url))
  await server.stop()
  expect(await response.json()).toEqual({ status: 'ok' })
})

test('loads every context server entry without React or client code', async () => {
  for (const contextServerEntry of contextServerEntries)
    expect(Object.keys(await import(contextServerEntry)).length).toBeGreaterThan(0)
  const build = await Bun.build({
    entrypoints: contextServerEntries.map((contextServerEntry) => Bun.resolveSync(contextServerEntry, import.meta.dir)),
    target: 'bun',
    metafile: true,
  })
  const loadedModules = Object.keys(build.metafile?.inputs ?? {})
  expect(loadedModules.length).toBeGreaterThan(contextServerEntries.length)
  expect(
    loadedModules.filter((path) =>
      /(^|\/)(node_modules\/(react|react-dom|react-router|@radix-ui|lucide-react)|packages\/(ui|session)|entrypoints)\/|packages\/db\/src\/useQuery\.tsx$/.test(
        path,
      ),
    ),
  ).toEqual([])
})
