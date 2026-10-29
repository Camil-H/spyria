import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
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

test('with a web build, the server serves the app with SPA fallback and cache rules, never shadowing its own routes', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'spyria-web-dist-'))
  mkdirSync(join(webDist, 'assets'))
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Spyria</title>')
  writeFileSync(join(webDist, 'assets', 'main-Ab12Cd34.js'), 'console.log(1)')
  const webApp = createApp({ database: unreachableDatabase, ...testAuthSettings, webDist })
  for (const appRoute of ['/', '/w/workspace-acme/chats/chat-1', '/w/workspace-acme/settings/github']) {
    const page = await webApp.request(appRoute)
    expect(page.status).toBe(200)
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(page.headers.get('content-type')).toStartWith('text/html')
    expect(await page.text()).toBe('<!doctype html><title>Spyria</title>')
  }
  const asset = await webApp.request('/assets/main-Ab12Cd34.js')
  expect(asset.status).toBe(200)
  expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await asset.text()).toBe('console.log(1)')
  expect((await webApp.request('/assets/missing-00000000.js')).status).toBe(404)
  expect((await webApp.request('/api/unknown')).status).toBe(401)
  expect((await webApp.request('/api/query', { method: 'POST', body: '[]' })).status).toBe(401)
  expect((await webApp.request('/auth/unknown')).status).toBe(404)
  const health = await webApp.request('/health')
  expect(health.status).toBe(503)
  expect(await health.json()).toEqual({ status: 'degraded', failing: ['database'] })
  expect((await app.request('/w/workspace-acme')).status).toBe(404)
  rmSync(webDist, { recursive: true })
})

test('the web app runs only its own scripts and frames web pages and reports, while a report runs in a sandbox of its own and a web page in one without its scripts, neither telling the sites they load where they are framed', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'spyria-web-dist-'))
  writeFileSync(join(webDist, 'index.html'), '<!doctype html><title>Spyria</title>')
  writeFileSync(join(webDist, 'report-frame.html'), '<!doctype html><script></script>')
  writeFileSync(join(webDist, 'page-frame.html'), '<!doctype html><script src="/page-frame.js"></script>')
  const webApp = createApp({ database: unreachableDatabase, ...testAuthSettings, webDist })
  const directivesOf = async (path: string) =>
    new Map(
      ((await webApp.request(path)).headers.get('content-security-policy') ?? '').split('; ').map((directive) => {
        const [name = '', ...sources] = directive.split(' ')
        return [name, sources]
      }),
    )
  for (const appRoute of ['/', '/w/workspace-acme/chats/chat-1']) {
    const app = await directivesOf(appRoute)
    expect(app.get('script-src')).toEqual(["'self'"])
    expect(app.get('object-src')).toEqual(["'none'"])
    expect(app.get('frame-ancestors')).toEqual(["'none'"])
    expect(app.get('frame-src')).toEqual(["'self'", 'http:', 'https:'])
  }
  const reportFrame = await directivesOf('/report-frame.html')
  expect(reportFrame.get('sandbox')).toEqual(['allow-scripts'])
  expect(reportFrame.get('default-src')).toContain("'unsafe-inline'")
  expect(reportFrame.get('frame-ancestors')).toEqual(["'self'"])
  const pageFrame = await directivesOf('/page-frame.html')
  expect(pageFrame.get('sandbox')).toEqual([
    'allow-scripts',
    'allow-forms',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
  ])
  expect(pageFrame.get('script-src')).toEqual(["'self'"])
  expect(pageFrame.get('frame-ancestors')).toEqual(["'self'"])
  for (const framePath of ['/report-frame.html', '/page-frame.html'])
    expect((await webApp.request(framePath)).headers.get('referrer-policy')).toBe('no-referrer')
  expect((await webApp.request('/')).headers.get('referrer-policy')).toBeNull()
  rmSync(webDist, { recursive: true })
})

test('the web app serves the precompressed variant the browser accepts, with its encoding and Vary, else the file itself', async () => {
  const webDist = mkdtempSync(join(tmpdir(), 'spyria-web-dist-'))
  mkdirSync(join(webDist, 'assets'))
  const page = '<!doctype html><title>Spyria</title>'
  const script = 'console.log(1)'
  writeFileSync(join(webDist, 'index.html'), page)
  writeFileSync(join(webDist, 'index.html.br'), brotliCompressSync(page))
  writeFileSync(join(webDist, 'index.html.gz'), gzipSync(page))
  writeFileSync(join(webDist, 'assets', 'main-Ab12Cd34.js'), script)
  writeFileSync(join(webDist, 'assets', 'main-Ab12Cd34.js.gz'), gzipSync(script))
  writeFileSync(join(webDist, 'assets', 'plain-Ab12Cd34.js'), script)
  const webApp = createApp({ database: unreachableDatabase, ...testAuthSettings, webDist })
  const fetched = async (path: string, headers: Record<string, string>) => {
    const response = await webApp.request(path, { headers })
    const body = Buffer.from(await response.arrayBuffer())
    const encoding = response.headers.get('content-encoding')
    return {
      encoding,
      vary: response.headers.get('vary'),
      type: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'),
      text: (encoding === 'br' ? brotliDecompressSync(body) : encoding === 'gzip' ? gunzipSync(body) : body).toString(),
    }
  }
  const html = 'text/html;charset=utf-8'
  const javascript = 'text/javascript;charset=utf-8'
  const immutable = 'public, max-age=31536000, immutable'
  for (const route of ['/', '/w/workspace-acme/chats/chat-1'])
    expect(await fetched(route, { 'accept-encoding': 'gzip, deflate, br' })).toEqual({
      encoding: 'br',
      vary: 'accept-encoding',
      type: html,
      cacheControl: 'no-cache',
      text: page,
    })
  expect(await fetched('/', { 'accept-encoding': 'br;q=0, gzip' })).toMatchObject({ encoding: 'gzip', text: page })
  expect(await fetched('/assets/main-Ab12Cd34.js', { 'accept-encoding': 'gzip, br' })).toEqual({
    encoding: 'gzip',
    vary: 'accept-encoding',
    type: javascript,
    cacheControl: immutable,
    text: script,
  })
  const identityRequests: Record<string, string>[] = [
    {},
    { 'accept-encoding': 'identity' },
    { 'accept-encoding': 'gzip', range: 'bytes=0-3' },
  ]
  for (const headers of identityRequests)
    expect(await fetched('/assets/main-Ab12Cd34.js', headers)).toEqual({
      encoding: null,
      vary: 'accept-encoding',
      type: javascript,
      cacheControl: immutable,
      text: script,
    })
  expect(await fetched('/assets/plain-Ab12Cd34.js', { 'accept-encoding': 'br, gzip' })).toMatchObject({
    encoding: null,
    text: script,
  })
  const head = await webApp.request('/assets/main-Ab12Cd34.js', {
    method: 'HEAD',
    headers: { 'accept-encoding': 'gzip' },
  })
  expect(head.status).toBe(200)
  expect(head.headers.get('content-encoding')).toBe('gzip')
  rmSync(webDist, { recursive: true })
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
