import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsOf } from './command-table.ts'
import { installFolderOf, readEnvironment } from './commands.ts'
import type { AzRunner } from './entra.ts'
import { parseEnvironment, serializeEnvironment } from './environment.ts'
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
    dataVolumesOf: () => [],
  })
const environment = () => parseEnvironment(readFileSync(join(folder, '.env'), 'utf8'))

test('an unattended setup creates the tunnel and writes the Compose file, the gateway config and a private .env', async () => {
  await runSetup(['--hostname', 'Spyria.Example.com'], {
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
    CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
    COMPOSE_PROFILES: 'host,cloudflare',
  })
  expect(readFileSync(join(folder, '.env'), 'utf8')).not.toContain('api-token')
})

test('setting up again without a Cloudflare token keeps the tunnel and every secret', async () => {
  const before = environment()
  await runSetup([])
  expect(environment()).toEqual(before)
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

test('an OIDC app for accounts takes its secret from the environment, keeps it when set up again without one, and - removes the app', async () => {
  await runSetup(['--oidc-issuer', 'https://login.example.com', '--oidc-client-id', 'spyria'], {
    SPYRIA_SETUP_OIDC_CLIENT_SECRET: 'oidc-secret',
  })
  const oidcSettings = {
    SPYRIA_OIDC_ISSUER: 'https://login.example.com',
    SPYRIA_OIDC_CLIENT_ID: 'spyria',
    SPYRIA_OIDC_CLIENT_SECRET: 'oidc-secret',
  }
  expect(environment()).toMatchObject(oidcSettings)
  await runSetup([])
  expect(environment()).toMatchObject(oidcSettings)
  await runSetup(['--oidc-issuer', '-'])
  for (const name of Object.keys(oidcSettings)) expect(environment()[name]).toBeUndefined()
})

test('an unattended setup refuses what it cannot decide: no hostname, a new hostname without a token, a malformed client id, an OIDC app without https or a secret', async () => {
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
    const withOidcApp = (issuer: string) => [
      '--hostname',
      'spyria.example.com',
      '--oidc-issuer',
      issuer,
      '--oidc-client-id',
      'spyria',
    ]
    expect(
      await attempt(withOidcApp('http://login.example.com'), {
        SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't',
        SPYRIA_SETUP_OIDC_CLIENT_SECRET: 'oidc-secret',
      }),
    ).toBe('http://login.example.com is not an https address')
    expect(await attempt(withOidcApp('https://login.example.com'), { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' })).toBe(
      'SPYRIA_SETUP_OIDC_CLIENT_SECRET is required',
    )
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
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: {},
        workspaceExistsIn: () => false,
        dataVolumesOf: () => [],
      },
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
    for (const command of ['upgrade', 'backup', 'restore', 'doctor', 'setup-link', 'compose'])
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
        dataVolumesOf: () => [],
      })
    await setupIn(['--hostname', 'spyria.example.com'], { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' })
    writeFileSync(join(install, 'compose.yml'), keptCompose)
    writeFileSync(join(install, 'bifrost.json'), 'kept gateway config')
    const environmentBefore = readFileSync(join(install, '.env'), 'utf8')
    const refusal = await setupIn(['--oidc-issuer', 'https://login.example.com', '--oidc-client-id', "o'brien"], {
      SPYRIA_SETUP_OIDC_CLIENT_SECRET: 'oidc-secret',
    }).catch((error: Error) => error.message)
    expect(refusal).toBe('SPYRIA_OIDC_CLIENT_ID cannot hold a quote or span lines')
    expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toBe(keptCompose)
    expect(readFileSync(join(install, 'bifrost.json'), 'utf8')).toBe('kept gateway config')
    expect(readFileSync(join(install, '.env'), 'utf8')).toBe(environmentBefore)
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('setting up again with a Microsoft app to create keeps the app and secret the first setup registered, and refuses an app whose secret the install lost', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const azFolder = mkdtempSync(join(tmpdir(), 'spyria-az-'))
  writeFileSync(join(azFolder, 'az'), '#!/bin/sh\n', { mode: 0o755 })
  const originalPath = process.env.PATH
  process.env.PATH = `${azFolder}:${originalPath}`
  const registeredApps: string[] = []
  const az: AzRunner = (azArguments) => {
    const command = azArguments.slice(0, 3).join(' ')
    if (command === 'ad app list') return { exitCode: 0, output: registeredApps.join('\n') }
    if (command === 'ad app create') {
      registeredApps.push(`0000000${registeredApps.length}-0000-4000-8000-000000000000`)
      return { exitCode: 0, output: registeredApps.at(-1) ?? '' }
    }
    if (command === 'ad app credential') return { exitCode: 0, output: `secret-${registeredApps.length}` }
    return { exitCode: 0, output: 'tenant-1' }
  }
  try {
    const setupIn = (processEnvironment = {}) =>
      setup(
        parseFlags([
          ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0'],
          ...['--hostname', 'spyria.example.com', '--microsoft-client-id', 'create'],
        ]),
        {
          cloudflareApiUrl: cloudflare.url.origin,
          processEnvironment,
          az,
          workspaceExistsIn: () => false,
          dataVolumesOf: () => [],
        },
      )
    const microsoftApp = () => {
      const { SPYRIA_MICROSOFT_CLIENT_ID, SPYRIA_MICROSOFT_CLIENT_SECRET } = readEnvironment(install)
      return { SPYRIA_MICROSOFT_CLIENT_ID, SPYRIA_MICROSOFT_CLIENT_SECRET }
    }
    await setupIn({ SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' })
    const registered = microsoftApp()
    expect(registered).toEqual({
      SPYRIA_MICROSOFT_CLIENT_ID: '00000000-0000-4000-8000-000000000000',
      SPYRIA_MICROSOFT_CLIENT_SECRET: 'secret-1',
    })
    await setupIn()
    expect(microsoftApp()).toEqual(registered)
    expect(registeredApps).toHaveLength(1)

    const { SPYRIA_MICROSOFT_CLIENT_SECRET: _lost, ...withoutSecret } = readEnvironment(install)
    writeFileSync(join(install, '.env'), serializeEnvironment(withoutSecret), { mode: 0o600 })
    expect(await setupIn().catch((error: Error) => error.message)).toBe(
      'Microsoft Entra already holds the app Spyria spyria.example.com (client id 00000000-0000-4000-8000-000000000000), whose secret this install does not have: give its client id and a new client secret of it instead of create',
    )
    expect(registeredApps).toHaveLength(1)
  } finally {
    process.env.PATH = originalPath
    rmSync(install, { recursive: true, force: true })
    rmSync(azFolder, { recursive: true, force: true })
  }
})

test('setup refuses an answer .env cannot hold before it creates the tunnel', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const tunnelsBefore = tunnelNames.length
  try {
    const refusal = await setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0'],
        ...['--hostname', 'spyria.example.com', '--oidc-issuer', 'https://login.example.com'],
        ...['--oidc-client-id', "o'brien"],
      ]),
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't', SPYRIA_SETUP_OIDC_CLIENT_SECRET: 'oidc-secret' },
        workspaceExistsIn: () => false,
        dataVolumesOf: () => [],
      },
    ).catch((error: Error) => error.message)
    expect(refusal).toBe('SPYRIA_OIDC_CLIENT_ID cannot hold a quote or span lines')
    expect(tunnelNames).toHaveLength(tunnelsBefore)
    expect(readdirSync(empty)).toEqual(['backups'])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('a setup failing after it registered the Microsoft app keeps the app and its secret in .env, so setting up again reuses them', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const azFolder = mkdtempSync(join(tmpdir(), 'spyria-az-'))
  writeFileSync(join(azFolder, 'az'), '#!/bin/sh\n', { mode: 0o755 })
  const originalPath = process.env.PATH
  process.env.PATH = `${azFolder}:${originalPath}`
  const registeredApps: string[] = []
  const az: AzRunner = (azArguments) => {
    const command = azArguments.slice(0, 3).join(' ')
    if (command === 'ad app list') return { exitCode: 0, output: registeredApps.join('\n') }
    if (command === 'ad app create') {
      registeredApps.push('00000000-0000-4000-8000-000000000000')
      return { exitCode: 0, output: registeredApps.at(-1) ?? '' }
    }
    if (command === 'ad app credential') return { exitCode: 0, output: 'secret-1' }
    return { exitCode: 0, output: 'tenant-1' }
  }
  try {
    const setupIn = (extra: string[]) =>
      setup(
        parseFlags([
          ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0'],
          ...['--hostname', 'spyria.example.com', '--microsoft-client-id', 'create', ...extra],
        ]),
        {
          cloudflareApiUrl: cloudflare.url.origin,
          processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't', SPYRIA_SETUP_OKTA_TOKEN: 'okta-token' },
          az,
          workspaceExistsIn: () => false,
          dataVolumesOf: () => [],
        },
      )
    const failure = await setupIn(['--provider', 'okta', '--okta-url', 'http://acme.okta.com']).catch(
      (error: Error) => error.message,
    )
    expect(failure).toBe('The Okta organization URL must start with https://, so the API token never travels in clear')
    const kept = {
      SPYRIA_MICROSOFT_CLIENT_ID: '00000000-0000-4000-8000-000000000000',
      SPYRIA_MICROSOFT_CLIENT_SECRET: 'secret-1',
      CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
    }
    expect(readEnvironment(install)).toMatchObject(kept)
    await setupIn([])
    expect(readEnvironment(install)).toMatchObject(kept)
    expect(registeredApps).toHaveLength(1)
  } finally {
    process.env.PATH = originalPath
    rmSync(install, { recursive: true, force: true })
    rmSync(azFolder, { recursive: true, force: true })
  }
})

test('setup without saved secrets refuses data this machine holds for the deployment before it creates the tunnel', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const tunnelsBefore = tunnelNames.length
  const askedDeployments: string[] = []
  try {
    const refusal = await setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0'],
        ...['--name', 'acme', '--hostname', 'spyria.example.com'],
      ]),
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' },
        workspaceExistsIn: () => false,
        dataVolumesOf: (deployment) => {
          askedDeployments.push(deployment)
          return [`${deployment}-postgres-data`]
        },
      },
    ).catch((error: Error) => error.message)
    expect(refusal).toStartWith('This machine holds the data of an earlier deployment named acme (acme-postgres-data)')
    expect(askedDeployments).toEqual(['acme'])
    expect(tunnelNames).toHaveLength(tunnelsBefore)
    expect(readdirSync(empty)).toEqual(['backups'])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
