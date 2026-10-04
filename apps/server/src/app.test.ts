import { expect, test } from 'bun:test'
import { createDatabase } from '@hq/db/postgres'
import { memberId, workspaceId } from '@hq/kernel'
import { createApp } from './app.ts'
import { createSessionTokens } from './session-tokens.ts'

const unreachableDatabase = createDatabase('postgres://unused:unused@127.0.0.1:1/unused')
const appWith = (isDevAuthEnabled: boolean) =>
  createApp({ database: unreachableDatabase, tokenSecret: 'unit-test-secret', isDevAuthEnabled })
const postDevToken = (isDevAuthEnabled: boolean) =>
  appWith(isDevAuthEnabled).request('/auth/dev-token', { method: 'POST', body: '{}' })

const contextServerEntries = [
  '@hq/workspace/server',
  '@hq/conversation/server',
  '@hq/profile/server',
  '@hq/panel/server',
]

test('serves health', async () => {
  const server = Bun.serve({ port: 0, fetch: appWith(false).fetch })
  const response = await fetch(new URL('/health', server.url))
  await server.stop()
  expect(await response.json()).toEqual({ status: 'ok' })
})

test('the dev token endpoint is mounted only when dev auth is enabled', async () => {
  expect((await postDevToken(false)).status).toBe(404)
  expect((await postDevToken(true)).status).toBe(400)
})

test.each(['/api/query', '/api/mutate'])('%s refuses a request without a bearer token', async (path) => {
  const response = await appWith(true).request(path, { method: 'POST', body: '[]' })
  expect(response.status).toBe(401)
})

test('refuses a token with a database claim when dev auth is disabled, without opening that database', async () => {
  const openedDatabaseNames: string[] = []
  const app = createApp({
    database: unreachableDatabase,
    tokenSecret: 'unit-test-secret',
    isDevAuthEnabled: false,
    databaseByName: (databaseName) => {
      openedDatabaseNames.push(databaseName)
      return unreachableDatabase
    },
  })
  const token = await createSessionTokens('unit-test-secret', async () => 'admin').issue(
    { userId: memberId('member-alice'), workspaceId: workspaceId('workspace-acme'), role: 'admin' },
    'hq_other',
  )
  const response = await app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '[]',
  })
  expect(response.status).toBe(403)
  expect(openedDatabaseNames).toEqual([])
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
