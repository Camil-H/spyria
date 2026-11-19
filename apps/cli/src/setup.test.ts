import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandsOf } from './command-table.ts'
import { installFolderOf, readEnvironment } from './commands.ts'
import type { DirectHttpsProbes } from './direct-https.ts'
import type { AzRunner } from './entra.ts'
import { type Environment, parseEnvironment, serializeEnvironment } from './environment.ts'
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
const deployment = `spyria-test-${crypto.randomUUID().slice(0, 8)}`
const reachableDirectly: DirectHttpsProbes = {
  addressesOf: async () => ['203.0.113.7'],
  isDockerRootless: () => false,
  unprivilegedPortStart: () => 1024,
  isPortInUse: async () => false,
}
const forgottenHostPairings: (string | undefined)[] = []
const withoutDocker = {
  workspaceExistsIn: () => false,
  dataVolumesOf: () => [],
  directHttpsProbes: reachableDirectly,
  forgetHostPairing: (_folder: string, environment: Environment) =>
    void forgottenHostPairings.push(environment.SPYRIA_DEPLOYMENT),
}
afterAll(() => {
  cloudflare.stop(true)
  rmSync(folder, { recursive: true, force: true })
})
const runSetup = (extra: string[], processEnvironment = {}) =>
  setup(
    parseFlags([
      ...['setup', '--unattended', '--no-start', '--folder', folder, '--version', '1.2.0', '--name', deployment],
      ...extra,
    ]),
    { cloudflareApiUrl: cloudflare.url.origin, processEnvironment, ...withoutDocker },
  )
const environment = () => parseEnvironment(readFileSync(join(folder, '.env'), 'utf8'))

test('an unattended setup creates the tunnel and writes the Compose file, the gateway config and a private .env', async () => {
  await runSetup(['--hostname', 'Spyria.Example.com'], {
    SPYRIA_SETUP_CLOUDFLARE_TOKEN: 'api-token',
  })
  expect(tunnelNames).toEqual([`${deployment}-spyria.example.com`])
  expect(readFileSync(join(folder, 'compose.yml'), 'utf8')).toContain('spyria-server:${SPYRIA_VERSION')
  expect(JSON.parse(readFileSync(join(folder, 'bifrost.json'), 'utf8'))).toMatchObject({
    encryption_key: 'env.BIFROST_ENCRYPTION_KEY',
  })
  expect(statSync(join(folder, '.env')).mode & 0o777).toBe(0o600)
  expect(environment()).toMatchObject({
    SPYRIA_DEPLOYMENT: deployment,
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
  expect(forgottenHostPairings).toEqual([])
  await runSetup(['--host'])
  expect(environment().COMPOSE_PROFILES).toBe('host,cloudflare')
  expect(environment().SPYRIA_HOST_CLAIM_URL).toStartWith('http://server:3000/h/')
  expect(forgottenHostPairings).toEqual([deployment])
})

test('run from inside an install without --folder, setup keeps that install and its secrets rather than writing another install', async () => {
  const before = environment()
  const originalDirectory = process.cwd()
  try {
    process.chdir(folder)
    await setup(parseFlags(['setup', '--unattended', '--no-start']), {
      cloudflareApiUrl: cloudflare.url.origin,
      processEnvironment: {},
      ...withoutDocker,
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
      setup(
        parseFlags([
          ...['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0', '--name', deployment],
          ...extra,
        ]),
        { cloudflareApiUrl: cloudflare.url.origin, processEnvironment, ...withoutDocker },
      ).catch((error: Error) => error.message)
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
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', project, '--name', deployment],
        ...['--hostname', 'spyria.example.com'],
      ]),
      { cloudflareApiUrl: cloudflare.url.origin, processEnvironment: {}, ...withoutDocker },
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
          '--name',
          deployment,
          '--hostname',
          'spyria.example.com',
          '--port',
          port,
        ]),
        {
          cloudflareApiUrl: cloudflare.url.origin,
          processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' },
          ...withoutDocker,
        },
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
      setup(
        parseFlags([
          ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0', '--name', deployment],
          ...extra,
        ]),
        { cloudflareApiUrl: cloudflare.url.origin, processEnvironment, ...withoutDocker },
      )
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
          ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0', '--name', deployment],
          ...['--hostname', 'spyria.example.com', '--microsoft-client-id', 'create'],
        ]),
        {
          cloudflareApiUrl: cloudflare.url.origin,
          processEnvironment,
          az,
          ...withoutDocker,
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
        ...['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0', '--name', deployment],
        ...['--hostname', 'spyria.example.com', '--oidc-issuer', 'https://login.example.com'],
        ...['--oidc-client-id', "o'brien"],
      ]),
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't', SPYRIA_SETUP_OIDC_CLIENT_SECRET: 'oidc-secret' },
        ...withoutDocker,
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
          ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0', '--name', deployment],
          ...['--hostname', 'spyria.example.com', '--microsoft-client-id', 'create', ...extra],
        ]),
        {
          cloudflareApiUrl: cloudflare.url.origin,
          processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' },
          az,
          ...withoutDocker,
        },
      )
    mkdirSync(join(install, 'bifrost.json'))
    const failure = await setupIn([]).catch((error: Error) => error.message)
    expect(failure).toContain('EISDIR')
    rmSync(join(install, 'bifrost.json'), { recursive: true })
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
        ...withoutDocker,
        dataVolumesOf: (askedDeployment) => {
          askedDeployments.push(askedDeployment)
          return [`${askedDeployment}-postgres-data`]
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

const directSetupIn = (
  install: string,
  extra: string[],
  {
    processEnvironment = {},
    probes = {},
  }: { processEnvironment?: Record<string, string>; probes?: Partial<DirectHttpsProbes> } = {},
) =>
  setup(
    parseFlags([
      ...['setup', '--unattended', '--no-start', '--folder', install, '--version', '1.2.0', '--name', deployment],
      ...extra,
    ]),
    {
      cloudflareApiUrl: cloudflare.url.origin,
      processEnvironment,
      ...withoutDocker,
      directHttpsProbes: { ...reachableDirectly, ...probes },
    },
  )
const printedBy = async (run: () => Promise<unknown>) => {
  const printed: string[] = []
  const log = spyOn(console, 'log').mockImplementation((...parts) => void printed.push(parts.join(' ')))
  try {
    await run()
  } finally {
    log.mockRestore()
  }
  return printed.join('\n')
}

test('--https direct sets up without a Cloudflare token: it writes the direct profile and a Caddyfile serving the hostname, and stores no tunnel token', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const tunnelsBefore = tunnelNames.length
  try {
    await directSetupIn(install, ['--hostname', 'spyria.example.com', '--https', 'direct'])
    const written = readEnvironment(install)
    expect(written).toMatchObject({
      SPYRIA_HTTPS: 'direct',
      SPYRIA_APP_ORIGIN: 'https://spyria.example.com',
      COMPOSE_PROFILES: 'host,direct',
      SPYRIA_TRUSTED_PROXY: 'x-forwarded-for:1',
    })
    expect(written.CLOUDFLARE_TUNNEL_TOKEN).toBeUndefined()
    expect(tunnelNames).toHaveLength(tunnelsBefore)
    const caddyfile = readFileSync(join(install, 'Caddyfile'), 'utf8')
    expect(caddyfile).toContain('{$SPYRIA_APP_ORIGIN} {')
    expect(caddyfile).toContain('reverse_proxy server:3000')
    expect(readFileSync(join(install, 'compose.yml'), 'utf8')).toContain('./Caddyfile:/etc/caddy/Caddyfile:ro')
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('--https direct refuses a hostname with no A or AAAA record before writing any file', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const askedHostnames: string[] = []
  try {
    const refusal = await directSetupIn(install, ['--hostname', 'spyria.example.com', '--https', 'direct'], {
      probes: {
        addressesOf: async (hostname: string) => {
          askedHostnames.push(hostname)
          return []
        },
      },
    }).catch((error: Error) => error.message)
    expect(refusal).toBe(
      'Point spyria.example.com at an address that reaches this machine from the internet (an A or AAAA record), then run this again.',
    )
    expect(askedHostnames).toEqual(['spyria.example.com'])
    expect(readdirSync(install)).toEqual(['backups'])
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('--https direct on rootless Docker that cannot publish port 80 refuses with the sysctl line to run, and goes on once it can', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    const refusal = await directSetupIn(install, ['--hostname', 'spyria.example.com', '--https', 'direct'], {
      probes: { isDockerRootless: () => true, unprivilegedPortStart: () => 1024 },
    }).catch((error: Error) => error.message)
    expect(refusal).toContain('sudo sysctl net.ipv4.ip_unprivileged_port_start=80')
    expect(refusal).toContain('/etc/sysctl.d/')
    expect(readdirSync(install)).toEqual(['backups'])
    await directSetupIn(install, ['--hostname', 'spyria.example.com', '--https', 'direct'], {
      probes: { isDockerRootless: () => true, unprivilegedPortStart: () => 80 },
    })
    expect(readEnvironment(install).SPYRIA_HTTPS).toBe('direct')
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('--https direct refuses when port 80 or 443 is taken on this machine, naming the port, before writing any file', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    for (const takenPort of [80, 443]) {
      const refusal = await directSetupIn(install, ['--hostname', 'spyria.example.com', '--https', 'direct'], {
        probes: { isPortInUse: async (port: number) => port === takenPort },
      }).catch((error: Error) => error.message)
      expect({ takenPort, refusal }).toEqual({
        takenPort,
        refusal: `Port ${takenPort} is in use on this machine: stop what listens on it, or choose --https tunnel, then run this again.`,
      })
    }
    expect(readdirSync(install)).toEqual(['backups'])
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('setting up again without --https keeps the saved mode; tunnel to direct removes the tunnel token and says how to delete the tunnel, and direct to tunnel asks for a token again', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    await directSetupIn(install, ['--hostname', 'spyria.example.com'], {
      processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' },
    })
    expect(readEnvironment(install)).toMatchObject({ SPYRIA_HTTPS: 'tunnel', COMPOSE_PROFILES: 'host,cloudflare' })
    await directSetupIn(install, [])
    expect(readEnvironment(install)).toMatchObject({
      SPYRIA_HTTPS: 'tunnel',
      CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
    })

    const switchOutput = await printedBy(() => directSetupIn(install, ['--https', 'direct']))
    const direct = readEnvironment(install)
    expect(direct).toMatchObject({ SPYRIA_HTTPS: 'direct', COMPOSE_PROFILES: 'host,direct' })
    expect(direct.CLOUDFLARE_TUNNEL_TOKEN).toBeUndefined()
    expect(switchOutput).toContain(`The tunnel ${deployment}-spyria.example.com and its DNS record stay in Cloudflare`)
    expect(switchOutput).toContain('Zero Trust > Networks > Tunnels')

    await directSetupIn(install, [])
    expect(readEnvironment(install)).toMatchObject({ SPYRIA_HTTPS: 'direct', COMPOSE_PROFILES: 'host,direct' })

    expect(await directSetupIn(install, ['--https', 'tunnel']).catch((error: Error) => error.message)).toBe(
      'A Cloudflare API token is required to create the tunnel',
    )
    await directSetupIn(install, ['--https', 'tunnel'], { processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 't' } })
    expect(readEnvironment(install)).toMatchObject({
      SPYRIA_HTTPS: 'tunnel',
      COMPOSE_PROFILES: 'host,cloudflare',
      CLOUDFLARE_TUNNEL_TOKEN: 'tunnel-token-1',
      SPYRIA_TRUSTED_PROXY: 'cloudflare',
    })
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('setting up again in direct mode does not take the ports its own Caddy holds for taken', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    await directSetupIn(install, ['--hostname', 'spyria.example.com', '--https', 'direct'])
    await directSetupIn(install, [], { probes: { isPortInUse: async () => true } })
    expect(readEnvironment(install).SPYRIA_HTTPS).toBe('direct')
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('a setup without --name names the deployment spyria, and its tunnel after it', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    await setup(
      parseFlags([
        ...['setup', '--unattended', '--no-start', '--folder', empty, '--version', '1.2.0'],
        ...['--hostname', 'spyria.example.com'],
      ]),
      {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: { SPYRIA_SETUP_CLOUDFLARE_TOKEN: 'api-token' },
        ...withoutDocker,
      },
    )
    expect(readEnvironment(empty).SPYRIA_DEPLOYMENT).toBe('spyria')
    expect(tunnelNames.at(-1)).toBe('spyria-spyria.example.com')
    expect(forgottenHostPairings).toEqual([deployment])
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})

test('an interactive direct setup with every account app asks for no workspace provider and no Cloudflare token', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  const answers: [RegExp, string][] = [
    [/^Hostname/, 'spyria.example.com'],
    [/^How will people reach Spyria/, 'direct'],
    [/^Google client id/, 'spyria.apps.googleusercontent.com'],
    [/^Microsoft client id/, '00000000-0000-4000-8000-000000000000'],
    [/^OIDC issuer URL/, 'https://login.example.com'],
    [/^OIDC client id/, 'spyria'],
    [/^Client secret/, 'secret'],
  ]
  const questions: string[] = []
  const ask = spyOn(globalThis, 'prompt').mockImplementation((question = '') => {
    questions.push(question)
    return answers.find(([pattern]) => pattern.test(question))?.[1] ?? ''
  })
  try {
    await printedBy(() =>
      setup(parseFlags(['setup', '--no-start', '--folder', install, '--version', '1.2.0', '--name', deployment]), {
        cloudflareApiUrl: cloudflare.url.origin,
        processEnvironment: {},
        ...withoutDocker,
      }),
    )
  } finally {
    ask.mockRestore()
  }
  try {
    expect(readEnvironment(install)).toMatchObject({ SPYRIA_HTTPS: 'direct', SPYRIA_OIDC_CLIENT_ID: 'spyria' })
    expect(questions.filter((question) => /Cloudflare API token|sign-in provider/i.test(question))).toEqual([])
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})

test('a removed or unknown setup flag is refused before any question or file', async () => {
  const install = mkdtempSync(join(tmpdir(), 'spyria-setup-'))
  try {
    for (const flag of ['--provider', '--owner-email', '--okta-url'])
      expect(
        await directSetupIn(install, ['--hostname', 'spyria.example.com', flag, 'value']).catch(
          (error: Error) => error.message,
        ),
      ).toBe(`${flag} is not a setup flag: spyria --help lists them`)
    expect(readdirSync(install)).toEqual([])
  } finally {
    rmSync(install, { recursive: true, force: true })
  }
})
