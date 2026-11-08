import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  composeFileOf,
  environmentFileOf,
  operatorCommandOf,
  readCompose,
  runCompose,
  spawnCompose,
} from './compose.ts'
import { type Environment, parseEnvironment, serializeEnvironment } from './environment.ts'
import { askerOf, type Flags } from './flags.ts'
import {
  backupNameOf,
  backupsToRemoveOf,
  diskProblemOf,
  productionProblemsIn,
  serviceProblemsOf,
  serviceStatesOf,
} from './health.ts'
import { cliVersion, latestVersion, releaseFileUrlOf, releaseNotesUrlOf } from './release.ts'

const backupDatabases = ['spyria', 'bifrost'] as const
const databaseOwners: Record<(typeof backupDatabases)[number], string> = { spyria: 'spyria', bifrost: 'bifrost' }
const defaultBackupsKept = 7
const healthWaitMilliseconds = 180_000

export const installFolderOf = (flags: Flags) => {
  const given = flags.values.folder
  if (given) return resolve(given.replace(/^~(?=$|\/)/, homedir()))
  if (existsSync(join(process.cwd(), 'compose.yml')) && existsSync(join(process.cwd(), '.env'))) return process.cwd()
  return join(homedir(), 'spyria')
}

export const readEnvironment = (folder: string): Environment => {
  if (!existsSync(environmentFileOf(folder)))
    throw new Error(`No Spyria install in ${folder}: run spyria setup, or pass --folder`)
  return parseEnvironment(readFileSync(environmentFileOf(folder), 'utf8'))
}

export const writeEnvironment = (folder: string, environment: Environment) => {
  writeFileSync(environmentFileOf(folder), serializeEnvironment(environment), { mode: 0o600 })
  chmodSync(environmentFileOf(folder), 0o600)
}

const step = (message: string) => console.log(`• ${message}`)
const mustSucceed = (exitCode: number | null, what: string) => {
  if (exitCode !== 0) throw new Error(`${what} failed`)
}

export const waitForHealth = async (environment: Environment) => {
  const url = `http://127.0.0.1:${environment.SPYRIA_LOCAL_PORT || '3300'}/health`
  for (const deadline = Date.now() + healthWaitMilliseconds; ; await Bun.sleep(2000)) {
    const answer = await fetch(url, { signal: AbortSignal.timeout(5000) }).then(
      async (response) => ({ ok: response.ok, body: await response.text() }),
      () => undefined,
    )
    if (answer?.ok) return
    if (Date.now() > deadline) throw new Error(`Spyria did not answer ${url} in time: ${answer?.body ?? 'no answer'}`)
  }
}

export const startStack = async (folder: string, environment: Environment) => {
  step('Pulling the images')
  mustSucceed(runCompose(folder, ['pull', '--quiet']), 'Pulling the images')
  step('Starting Spyria')
  mustSucceed(runCompose(folder, ['up', '-d', '--remove-orphans']), 'Starting Spyria')
  await waitForHealth(environment)
  step('Spyria answers')
}

export const keptBackupsOf = (flags: Flags) => {
  const keep = Number(flags.values.keep ?? defaultBackupsKept)
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep takes a whole number of backups, at least 1')
  return keep
}

export const backup = async (folder: string, flags: Flags) => {
  const keep = keptBackupsOf(flags)
  const backupsFolder = join(folder, 'backups')
  mkdirSync(backupsFolder, { recursive: true, mode: 0o700 })
  chmodSync(backupsFolder, 0o700)
  const now = new Date()
  const written: string[] = []
  for (const database of backupDatabases) {
    const path = join(backupsFolder, backupNameOf(database, now))
    writeFileSync(path, '', { mode: 0o600 })
    const exitCode = await spawnCompose(
      folder,
      ['exec', '-T', 'postgres', 'pg_dump', '-U', 'spyria', '-d', database, '-Fc'],
      { stdout: Bun.file(path) },
    )
    chmodSync(path, 0o600)
    if (exitCode !== 0) {
      rmSync(path, { force: true })
      throw new Error(`Backing up the ${database} database failed`)
    }
    written.push(path)
  }
  for (const file of backupsToRemoveOf(readdirSync(backupsFolder), keep)) rmSync(join(backupsFolder, file))
  for (const path of written) step(`Backed up to ${path}`)
  return written
}

const psqlCommandOf = (sql: string) => [
  'exec',
  '-T',
  'postgres',
  'psql',
  '-U',
  'spyria',
  '-d',
  'postgres',
  '-v',
  'ON_ERROR_STOP=1',
  '-c',
  sql,
]

export const restore = async (folder: string, flags: Flags) => {
  const [, file] = flags.positionals
  if (!file) throw new Error('Usage: spyria restore <backups/spyria-….dump>')
  const path = resolve(folder, file)
  const database = backupDatabases.find((candidate) => path.split('/').at(-1)?.startsWith(`${candidate}-`))
  if (!database || !existsSync(path)) throw new Error(`${file} is not a backup of spyria or bifrost`)
  const environment = readEnvironment(folder)
  const profiles = (environment.COMPOSE_PROFILES ?? '').split(',')
  if (runCompose(folder, ['exec', '-T', 'postgres', 'pg_isready', '-U', 'spyria']) !== 0)
    throw new Error('Postgres is not running: start it with spyria compose up -d postgres, then restore again')
  step(`Reading ${file} whole before changing anything`)
  const readable = await spawnCompose(folder, ['exec', '-T', 'postgres', 'pg_restore', '--file=/dev/null'], {
    stdin: Bun.file(path),
  })
  if (readable !== 0) throw new Error(`${file} is not a complete backup made by spyria backup: nothing was changed`)
  step('Stopping the server, zero-cache, the gateway and the host')
  mustSucceed(
    runCompose(folder, ['stop', 'server', 'zero-cache', 'gateway', ...(profiles.includes('host') ? ['host'] : [])]),
    'Stopping',
  )
  step(`Replacing the ${database} database with ${file}`)
  mustSucceed(
    runCompose(
      folder,
      psqlCommandOf(
        `select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = '${database}'`,
      ),
    ),
    'Dropping its replication slots',
  )
  mustSucceed(
    runCompose(folder, ['exec', '-T', 'postgres', 'dropdb', '-U', 'spyria', '--force', '--if-exists', database]),
    `Dropping ${database}`,
  )
  mustSucceed(
    runCompose(folder, [
      ...['exec', '-T', 'postgres', 'createdb', '-U', 'spyria', '-O', databaseOwners[database]],
      ...['-T', 'template0', '-E', 'UTF8', database],
    ]),
    `Creating ${database}`,
  )
  const exitCode = await spawnCompose(
    folder,
    ['exec', '-T', 'postgres', 'pg_restore', '-U', 'spyria', '-d', database, '--exit-on-error'],
    { stdin: Bun.file(path) },
  )
  mustSucceed(exitCode, `Restoring ${file}`)
  if (database === 'spyria') {
    step("Dropping zero-cache's replica, which it rebuilds from the restored database")
    mustSucceed(runCompose(folder, ['rm', '-f', 'zero-cache']), 'Removing zero-cache')
    const volume = `${environment.SPYRIA_DEPLOYMENT}-zero-data`
    const removed = Bun.spawnSync(['docker', 'volume', 'rm', volume], { stdout: 'ignore', stderr: 'pipe' })
    if (removed.exitCode !== 0 && !removed.stderr.toString().includes('no such volume'))
      throw new Error(`Removing ${volume} failed: ${removed.stderr.toString().trim()}`)
  }
  mustSucceed(runCompose(folder, ['up', '-d']), 'Starting Spyria')
  await waitForHealth(environment)
  step(`Restored ${file}`)
}

export const releaseFilesOf = async (version: string, fileUrlOf = releaseFileUrlOf) => {
  const [compose = '', bifrost = ''] = await Promise.all(
    ['deploy/compose.prod.yml', 'deploy/bifrost.json'].map(async (path) => {
      const response = await fetch(fileUrlOf(version, path))
      if (!response.ok) throw new Error(`Version ${version} has no ${path} (${response.status})`)
      return response.text()
    }),
  )
  return { compose, bifrost }
}

export const writeReleaseFiles = (folder: string, { compose, bifrost }: { compose: string; bifrost: string }) => {
  writeFileSync(composeFileOf(folder), compose)
  writeFileSync(join(folder, 'bifrost.json'), bifrost)
}

export const upgrade = async (
  folder: string,
  flags: Flags,
  { fileUrlOf = releaseFileUrlOf }: { fileUrlOf?: typeof releaseFileUrlOf } = {},
) => {
  const environment = readEnvironment(folder)
  const version = flags.positionals[1] ?? (await latestVersion())
  step(`Upgrading from ${environment.SPYRIA_VERSION} to ${version}`)
  const files = await releaseFilesOf(version, fileUrlOf)
  await backup(folder, flags)
  writeReleaseFiles(folder, files)
  const upgraded = { ...environment, SPYRIA_VERSION: version }
  writeEnvironment(folder, upgraded)
  await startStack(folder, upgraded)
  console.log(`Spyria ${version} runs. What changed: ${releaseNotesUrlOf(version)}`)
  if (version !== cliVersion && cliVersion !== 'dev')
    console.log(`This spyria tool is ${cliVersion}: install the one of ${version} with install.sh to match it.`)
}

export const doctor = (folder: string) => {
  const environment = readEnvironment(folder)
  const problems: string[] = []
  const docker = Bun.which('docker', { PATH: process.env.PATH ?? '' })
  if (docker === null || Bun.spawnSync([docker, 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0)
    problems.push('Docker does not answer: start Docker')
  else {
    const profiles = (environment.COMPOSE_PROFILES ?? '').split(',').filter(Boolean)
    const states = serviceStatesOf(readCompose(folder, ['ps', '--all', '--format', 'json']).output)
    problems.push(...serviceProblemsOf(states, profiles))
    problems.push(...productionProblemsIn(readCompose(folder, ['logs', '--tail', '200', 'server']).output))
    const images = readCompose(folder, ['images', '--format', 'json']).output.trim()
    if (images)
      step(
        `Images: ${(JSON.parse(images) as { Repository: string; Tag: string }[]).map(({ Repository, Tag }) => `${Repository}:${Tag}`).join(', ')}`,
      )
  }
  const { bavail, bsize } = statfsSync(folder)
  const diskProblem = diskProblemOf((bavail * bsize) / 1024)
  if (diskProblem) problems.push(diskProblem)
  step(`Version ${environment.SPYRIA_VERSION}, address ${environment.SPYRIA_APP_ORIGIN}`)
  for (const problem of problems) console.log(`✗ ${problem}`)
  if (problems.length === 0) console.log('✓ Spyria looks healthy')
  return problems.length === 0
}

export const runOperator = (folder: string, operatorArguments: string[]) =>
  mustSucceed(runCompose(folder, operatorCommandOf(operatorArguments)), `spyria ${operatorArguments[0]}`)

export const verifyDomain = (folder: string, flags: Flags) => {
  const { workspace, domain } = flags.values
  if (!workspace || !domain) throw new Error('Usage: spyria verify-domain --workspace <id> --domain <domain>')
  runOperator(folder, ['sso:verify-domain', '--workspace', workspace, '--domain', domain])
}

export const printSetupLink = (folder: string) => runOperator(folder, ['setup-link'])

const typedOrPipedSecret = async () =>
  process.stdin.isTTY ? (prompt('Client secret of the new sign-in app') ?? '') : await Bun.stdin.text()

export const changeSignInApp = async (
  folder: string,
  flags: Flags,
  { readSecret = typedOrPipedSecret }: { readSecret?: () => Promise<string> } = {},
) => {
  const asker = askerOf(flags)
  const clientId = asker.require('client-id', 'Client id of the new sign-in app')
  const clientSecret = (await readSecret()).trim()
  if (clientSecret === '') throw new Error('The client secret is required, typed or on standard input')
  mustSucceed(
    runCompose(folder, operatorCommandOf(['sso:sign-in-app', '--client-id', clientId]), clientSecret),
    'spyria sign-in-app',
  )
}

export const sendsTestMessage = (folder: string, address: string) =>
  runCompose(folder, operatorCommandOf(['mail:test', '--to', address])) === 0
