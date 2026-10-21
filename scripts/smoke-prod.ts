import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkTrust } from './check-trust.ts'

const repositoryRoot = new URL('..', import.meta.url).pathname
const composeFile = `${repositoryRoot}deploy/compose.prod.yml`
const deployment = `spyria-smoke-${randomBytes(4).toString('hex')}`
const secretOf = () => randomBytes(24).toString('hex')
const freePort = () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const { port } = probe
  probe.stop(true)
  return port
}
const localPort = freePort()
const serverUrl = `http://127.0.0.1:${localPort}`
const environmentDirectory = mkdtempSync(join(tmpdir(), `${deployment}-`))
const environmentFile = join(environmentDirectory, '.env')
const smokeEnvironment = {
  SPYRIA_DEPLOYMENT: deployment,
  SPYRIA_APP_ORIGIN: 'https://localhost',
  SPYRIA_TOKEN_SECRET: secretOf(),
  SPYRIA_SECRETS_KEY: secretOf(),
  SPYRIA_SMTP_URL: `smtp://smoke:${secretOf()}@127.0.0.1:2525`,
  SPYRIA_MAIL_FROM: 'Spyria smoke <smoke@example.com>',
  SPYRIA_GATEWAY_ADMIN_USER: `admin-${secretOf().slice(0, 8)}`,
  SPYRIA_GATEWAY_ADMIN_PASSWORD: secretOf(),
  SPYRIA_GATEWAY_ENCRYPTION_KEY: secretOf(),
  SPYRIA_GATEWAY_SETUP_TOKEN: secretOf(),
  SPYRIA_GATEWAY_DB_PASSWORD: secretOf(),
  SPYRIA_POSTGRES_PASSWORD: secretOf(),
  SPYRIA_ZERO_ADMIN_PASSWORD: secretOf(),
  SPYRIA_LOCAL_PORT: String(localPort),
}
const isSettingOfThisFile = (name: string) => /^(SPYRIA_|COMPOSE_|OTEL_|CLOUDFLARE_)/.test(name)
const shellEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !isSettingOfThisFile(name)))

const run = (command: string[]) =>
  Bun.spawnSync(command, { cwd: repositoryRoot, env: shellEnvironment, stdout: 'inherit', stderr: 'inherit' }).exitCode
const output = (command: string[]) =>
  Bun.spawnSync(command, { env: shellEnvironment, stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()
const compose = (...composeArguments: string[]) =>
  run(['docker', 'compose', '--env-file', environmentFile, '-f', composeFile, ...composeArguments])
const step = (message: string) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}] ${message}`)
const check = (isPassed: boolean, message: string) => {
  if (!isPassed) throw new Error(message)
  step(`ok: ${message}`)
}

const leftoversOf = () =>
  [
    ['docker', 'ps', '-aq', '--filter', `name=${deployment}`],
    ['docker', 'volume', 'ls', '-q', '--filter', `name=${deployment}`],
    ['docker', 'network', 'ls', '-q', '--filter', `name=${deployment}`],
    ['docker', 'image', 'ls', '-q', `${deployment}-*`],
  ].flatMap((command) => output(command).split('\n').filter(Boolean))

let isTornDown = false
const tearDown = () => {
  if (isTornDown) return
  isTornDown = true
  step(`tearing down ${deployment}`)
  compose('down', '--volumes', '--remove-orphans', '--timeout', '15')
  run(['docker', 'image', 'rm', `${deployment}-server`])
  rmSync(environmentDirectory, { recursive: true, force: true })
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    tearDown()
    process.exit(1)
  })

const smoke = async () => {
  if (!existsSync(`${repositoryRoot}apps/agent/image-id`))
    throw new Error('apps/agent/image-id is missing: run bun run agent:build first')
  const environmentText = Object.entries(smokeEnvironment).map(([name, value]) => `${name}=${value}\n`)
  writeFileSync(environmentFile, environmentText.join(''), { mode: 0o600 })
  step(`starting ${deployment} (server on ${serverUrl})`)
  if (compose('up', '-d', '--build', '--wait', '--wait-timeout', '600') !== 0) {
    compose('ps', '-a')
    compose('logs', '--tail', '40')
    throw new Error('the production stack did not become healthy')
  }
  const health = await fetch(`${serverUrl}/health`)
  check(health.status === 200 && (await health.json()).status === 'ok', '/health answers 200 {status: ok}')
  const page = await fetch(`${serverUrl}/`)
  const html = await page.text()
  check(page.status === 200 && html.includes('<div id="root">'), '/ serves the web app')
  check(page.headers.get('cache-control') === 'no-cache', 'index.html is no-cache')
  const assetPath = html.match(/\/assets\/[\w-]+\.js/)?.[0]
  check(assetPath !== undefined, `index.html references a hashed asset (${assetPath})`)
  const asset = await fetch(`${serverUrl}${assetPath}`)
  await asset.arrayBuffer()
  check(asset.status === 200, `${assetPath} answers 200`)
  check(
    asset.headers.get('cache-control') === 'public, max-age=31536000, immutable',
    'the hashed asset is cached for a year, immutable',
  )
  for (const [encoding, path] of [
    ['br', '/'],
    ['br', assetPath],
    ['gzip', assetPath],
  ] as const) {
    const compressed = await fetch(`${serverUrl}${path}`, { headers: { 'accept-encoding': encoding } })
    const identity = await fetch(`${serverUrl}${path}`, { headers: { 'accept-encoding': 'identity' } })
    const [compressedText, identityText] = [await compressed.text(), await identity.text()]
    check(
      compressed.headers.get('content-encoding') === encoding &&
        compressed.headers.get('vary') === 'accept-encoding' &&
        identity.headers.get('content-encoding') === null &&
        compressedText === identityText,
      `${path} is served precompressed with ${encoding} (Vary: accept-encoding) and as is without it`,
    )
  }
  check(
    await checkTrust([`${deployment}-server`, `${deployment}-gateway`]),
    'the server image and the running gateway trust no distrusted root',
  )
  const authMode = await (await fetch(`${serverUrl}/auth/mode`)).json()
  check(
    authMode.authMode === 'sso' && authMode.canCreateWorkspace === true,
    '/auth/mode offers creating the first workspace',
  )
}

let isPassed = false
try {
  await smoke()
  isPassed = true
} catch (error) {
  console.error(`[smoke] failed: ${error instanceof Error ? error.message : error}`)
} finally {
  tearDown()
}
const leftovers = leftoversOf()
if (leftovers.length > 0) console.error(`[smoke] ${deployment} left Docker objects behind: ${leftovers.join(', ')}`)
step(isPassed && leftovers.length === 0 ? 'passed' : 'failed')
process.exit(isPassed && leftovers.length === 0 ? 0 : 1)
