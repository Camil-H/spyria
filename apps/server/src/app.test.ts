import { expect, test } from 'bun:test'
import { createDatabase } from '@spyria/db/postgres'
import { llmCredentialsPath } from '@spyria/profile/server'
import { runtimeHostsPath } from '@spyria/runtime/server'
import { createApp } from './app.ts'
import { issueSessionToken } from './auth/session-tokens.ts'
import { testAuthSettings } from './testing/testing.ts'

const unreachableDatabase = createDatabase('postgres://unused:unused@127.0.0.1:1/unused')
const app = createApp({ database: unreachableDatabase, ...testAuthSettings })

const contextServerEntries = [
  '@spyria/workspace/server',
  '@spyria/conversation/server',
  '@spyria/profile/server',
  '@spyria/runtime/server',
]

test('health names the unreachable database', async () => {
  const server = Bun.serve({ port: 0, fetch: app.fetch })
  const response = await fetch(new URL('/health', server.url))
  await server.stop()
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ status: 'degraded', failing: ['database'] })
})

test.each(['/api/query', '/api/mutate', llmCredentialsPath, runtimeHostsPath, `${runtimeHostsPath}/host-1/code`])(
  '%s refuses a request without a bearer token',
  async (path) => {
    const response = await app.request(path, { method: 'POST', body: '[]' })
    expect(response.status).toBe(401)
  },
)

test('refuses a token with a database claim without test hooks, without opening any database', async () => {
  const { token } = await issueSessionToken(
    testAuthSettings.tokenSecret,
    { userId: 'member-alice', workspaceId: 'workspace-acme', sessionId: 'session-1' },
    { databaseName: 'spyria_other' },
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
