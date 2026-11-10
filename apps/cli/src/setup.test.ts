import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsOf } from './command-table.ts'
import { installFolderOf, readEnvironment } from './commands.ts'
import { parseEnvironment } from './environment.ts'
import { parseFlags } from './flags.ts'
import { setup } from './setup.ts'

const ok = (result: unknown) => Response.json({ success: true, errors: [], result })
const tunnelNames: string[] = []
const cloudflare = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (pathname === '/zones') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'account-1' } }])
    if (pathname === '/accounts/account-1/cfd_tunnel' && request.method === 'POST') {
      tunnelNames.push(((await request.json()) as { name: string }).name)
      return ok({ id: 'tunnel-1', name: tunnelNames.at(-1) })
    }
    if (pathname.endsWith('/token')) return ok('tunnel-token-1')
    if (request.method === 'GET') return ok([])
    return ok({})
  },
})
const folder = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
afterAll(() => {
  cloudflare.stop(true)
  rmSync(folder, { recursive: true, force: true })
})
const runSetup = (extra: string[], processEnvironment = {}) =>
  setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', folder, '--version', '1.2.0', ...extra]), {
    cloudflareApiUrl: cloudflare.url.origin,
    processEnvironment,
    workspaceExistsIn: () => false,
  })
const environment = () => parseEnvironment(readFileSync(join(folder, '.env'), 'utf8'))

test('an unattended setup creates the tunnel and writes the Compose file, the gateway config and a private .env', async () => {
  await runSetup(['--hostname', 'Spyria.Example.com', '--join-by', 'invited-address'], {
    SPYRIA_SETUP_CLOUDFLARE_TOKEN: 'api-token',
  })
  expect(tunnelNames).toEqual(['spyria-spyria.example.com'])
  expect(readFileSync(join(folder, 'compose.yml'), 'utf8')).toContain('spyria-server:${SPYRIA_VERSION')
  expect(JSON.parse(readFileSync(join(folder, 'bifrost.json'), 'utf8'))).toMatchObject({
    encryption_key: 'env.BIFROST_ENCRYPTION_KEY',
  })
  expect(statSync(join(folder, '.env')).mode & 0o777).toBe(0o600)
  expect(environment()).toMatchObject({
    SPYRIA_DEPLOYMENT: 'spyria',
    SPYRIA_VERSION: '1.2.0',
    SPYRIA_APP_ORIGIN: 'https://spyria.example.com',
    SPYRIA_JOIN_BY: 'invited-address',
    CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
    COMPOSE_PROFILES: 'host,cloudflare',
  })
  expect(readFileSync(join(folder, '.env'), 'utf8')).not.toContain('api-token')
})

test('setting up again without a Cloudflare token keeps the tunnel and every secret', async () => {
  const before = environment()
  await runSetup(['--version', '1.3.0'])
  const after = environment()
  expect(after).toEqual({ ...before, SPYRIA_VERSION: '1.3.0' })
  expect(tunnelNames).toHaveLength(1)
})

test('setting up again keeps a deployment without a runtime host that way until --host turns it back on', async () => {
  await runSetup(['--no-host'])
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBeUndefined()
  await runSetup([])
  expect(environment().COMPOSE_PROFILES).toBe('cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toBeUndefined()
  await runSetup(['--host'])
  expect(environment().COMPOSE_PROFILES).toBe('host,cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toStartWith('http://server:3000/h/')
})

test('run from inside an install without --folder, setup keeps that install and its secrets rather than writing another install', async () => {
  const before = environment()
  const originalDirectory = process.cwd()
  try {
    process.chdir(folder)
    await setup(parseFlags(['setup', '--unattended', '--no-start']), {
      cloudflareApiUrl: cloudflare.url.origin,
      processEnvironment: {},
    })
    expect(environment()).toEqual(before)
  } finally {
    process.chdir(originalDirectory)
  }
})

test('choosing an SMTP URL again keeps the saved one when none is given', async () => {
  await runSetup(['--mail', 'smtp', '--mail-from', 'Spyria <spyria@example.com>'], {
    SPYRIA_SETUP_SMTP_URL: 'smtps://user:saved@smtp.example.com:465',
  })
  await runSetup(['--mail', 'smtp'])
  expect(environment().SPYRIA_SMTP_URL).toBe('smtps://user:saved@smtp.example.com:465')
})

test('an unattended setup refuses what it cannot decide: no hostname, a new hostname without a token, a malformed client id', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    const attempt = (extra: string[], processEnvironment = {}) =>
      setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0', ...extra]), {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment,
      }).catch((error: Error) => error.message)
    expect(await attempt([])).toBe('--hostname is required')
    expect(await attempt(['--hostname', 'spyria.example.com'])).toBe(
      'A Cloudflare API token is required to create the tunnel',
    )
    expect(
      await attempt(['--hostname', 'spyria.example.com', '--google-client-id', 'not-google'], {
        SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't',
      }),
    ).toBe('not-google is not a Google OAuth client id')
    expect(
      await attempt(
        ['--hostname', 'spyria.example.com', '--join-by', 'invited-address', '--provider', 'cloudflare-access'],
        {
          SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't',
        },
      ),
    ).toBe('--provider must be microsoft or okta or google or other or skip')
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test("setup refuses a folder holding another project's compose.yml or .env and leaves it as it was, and no command takes such a folder for an install", async () => {
  const project = mkdtempSync(join(tmpdir(), 'other-project-'))
  const theirCompose = 'services:\n  web:\n    image: nginx\n'
  const theirEnvironment = 'POSTGRES_PASSWORD=theirs\n'
  writeFileSync(join(project, 'compose.yml'), theirCompose)
  writeFileSync(join(project, '.env'), theirEnvironment)
  const originalDirectory = process.cwd()
  try {
    const refusal = await setup(
      parseFlags(['setup', '--unattended', '--no-start', '--folder', project, '--hostname', 'spyria.example.com']),
      { cloudflareApiUrl: cloudflare.url.origin, processEnvironment: {}, workspaceExistsIn: () => false },
    ).catch((error: Error) => error.message)
    expect(refusal).toBe(`The .env and compose.yml in ${project} are not Spyria's: choose another folder with --folder`)
    expect(readdirSync(project).sort()).toEqual(['.env', 'compose.yml'])
    expect(readFileSync(join(project, 'compose.yml'), 'utf8')).toBe(theirCompose)
    expect(readFileSync(join(project, '.env'), 'utf8')).toBe(theirEnvironment)
    expect(() => readEnvironment(project)).toThrow(`No Spyria install in ${project}`)
    process.chdir(project)
    expect(installFolderOf(parseFlags(['setup']))).toBe(join(homedir(), 'spyria'))
  } finally {
    process.chdir(originalDirectory)
    rmSync(project, { recursive: true, force: true })
  }
})

test('every command of an install refuses a folder that is not one and writes nothing there, and an unreadable .env in the current folder is no install rather than a crash', async () => {
  const project = mkdtempSync(join(tmpdir(), 'other-project-'))
  writeFileSync(join(project, 'compose.yml'), 'services:\n  web:\n    image: nginx\n')
  writeFileSync(join(project, '.env'), 'POSTGRES_PASSWORD=theirs\n')
  const refusalOf = async (command: string) => {
    const commandLine = ['bun', 'main.ts', command, '--folder', project]
    const run = commandsOf(parseFlags(commandLine.slice(2)), commandLine)[command]
    return (async () => run?.())().then(
      () => 'ran',
      (error: Error) => error.message,
    )
  }
  const originalDirectory = process.cwd()
  try {
    for (const command of [
      'upgrade',
      'backup',
      'restore',
      'doctor',
      'setup-link',
      'verify-domain',
      'sign-in-app',
      'compose',
    ])
      expect({ command, refusal: await refusalOf(command) }).toEqual({
        command,
        refusal: `No Spyria install in ${project}: run spyria setup, or pass --folder`,
      })
    expect(readdirSync(project).sort()).toEqual(['.env', 'compose.yml'])
    rmSync(join(project, '.env'))
    mkdirSync(join(project, '.env'))
    process.chdir(project)
    expect(installFolderOf(parseFlags(['version']))).toBe(join(homedir(), 'spyria'))
  } finally {
    process.chdir(originalDirectory)
    rmSync(project, { recursive: true, force: true })
  }
})

test('setup refuses a --port that is not a port number before it creates a tunnel or writes a file', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const tunnelsBefore = tunnelNames.length
  try {
    for (const port of ['abc', '0', '65536', '3300.5']) {
      const refusal = await setup(
        parseFlags([
          'setup',
          '--unattended',
          '--no-start',
          '--folder',
          empty,
          '--hostname',
          'spyria.example.com',
          '--port',
          port,
        ]),
        { cloudflareApiUrl: cloudflare.url.origin, processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' } },
      ).catch((error: Error) => error.message)
      expect({ port, refusal }).toEqual({ port, refusal: '--port takes a port number from 1 to 65535' })
    }
    expect(readdirSync(empty)).toEqual(['backups'])
    expect(tunnelNames).toHaveLength(tunnelsBefore)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('setup refuses an answer .env cannot hold before it rewrites compose.yml and bifrost.json', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const keptCompose = `name: \${SPYRIA_DEPLOYMENT}\n# kept\n`
  try {
    const setupIn = (extra: string[], processEnvironment = {}) =>
      setup(parseFlags(['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0', ...extra]), {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment,
        workspaceExistsIn: () => false,
      })
    await setupIn(['--hostname', 'spyria.example.com'], { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' })
    writeFileSync(join(install, 'compose.yml'), keptCompose)
    writeFileSync(join(install, 'bifrost.json'), 'kept gateway config')
    const environmentBefore = readFileSync(join(install, '.env'), 'utf8')
    const refusal = await setupIn(['--mail', 'smtp', '--mail-from', "O'Brien <spyria@example.com>"], {
      SPYRIA_SETUP_SMTP_URL: 'smtps://user:secret@smtp.example.com:465',
    }).catch((error: Error) => error.message)
    expect(refusal).toBe('SPYRIA_MAIL_FROM cannot hold a quote or span lines')
    expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toBe(keptCompose)
    expect(readFileSync(join(install, 'bifrost.json'), 'utf8')).toBe('kept gateway config')
    expect(readFileSync(join(install, '.env'), 'utf8')).toBe(environmentBefore)
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})
