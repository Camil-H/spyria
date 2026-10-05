import { expect, test } from 'bun:test'
import { createDatabase } from '@hq/db/postgres'
import { llmCredentialsPath } from '@hq/profile/server'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { testAuthSettings } from './testing.ts'

const unreachableDatabase = createDatabase('postgres://unused:unused@127.0.0.1:1/unused')
const app = createApp({ database: unreachableDatabase, ...testAuthSettings })

const contextServerEntries = ['@hq/workspace/server', '@hq/conversation/server', '@hq/profile/server']

test('serves health', async () => {
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const response = await fetch(new URL('/health', server.url))
  await server.stop()
  expect(await response.json()).toEqual({ status: 'ok' })
})

test('the dev token endpoint is gone', async () => {
  expect((await app.request('/auth/dev-token', { method: 'POST', body: '{}' })).status).toBe(404)
})

test.each(['/api/query', '/api/mutate', llmCredentialsPath])(
  '%s refuses a request without a bearer token',
  async (path) => {
    const response = await app.request(path, { method: 'POST', body: '[]' })
    expect(response.status).toBe(401)
  },
)

test('refuses a token with a database claim without test hooks, without opening any database', async () => {
  const { token } = await issueSessionToken(
    testAuthSettings.tokenSecret,
    { userId: 'member-alice', workspaceId: 'workspace-acme', role: 'admin', sessionId: 'session-1' },
    { databaseName: 'hq_other' },
  )
  const response = await app.request('/api/query', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: '[]',
  })
  expect(response.status).toBe(403)
})

test('loads every context server entry without React or client code', async () => {
  for (const contextServerEntry of contextServerEntries)
    expect(Object.keys(await import(contextServerEntry)).length).toBeGreaterThan(0)
  const entryReexports = contextServerEntries.map(
    (contextServerEntry, index) =>
      `export * as entry${index} from ${JSON.stringify(Bun.resolveSync(contextServerEntry, import.meta.dir))}`,
  )
  const build = await Bun.build({
    entrypoints: ['/server-entries.ts'],
    files: { '/server-entries.ts': entryReexports.join('\n') },
    target: 'bun',
    metafile: true,
  })
  const loadedModules = Object.keys(build.metafile?.inputs ?? {})
  expect(loadedModules.length).toBeGreaterThan(contextServerEntries.length)
  expect(
    loadedModules.filter((path) =>
      /(^|\/)(node_modules\/(react|react-dom|react-router|@radix-ui|lucide-react)|packages\/(ui|session))\/|entrypoints\/(?!(mutators|jobs|endpoints)\.ts$)|packages\/db\/src\/useQuery\.tsx$/.test(
        path,
      ),
    ),
  ).toEqual([])
})
