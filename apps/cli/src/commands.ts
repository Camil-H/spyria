import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
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
import type { Flags } from './flags.ts'
import {
  backupNameOf,
  backupsToRemoveOf,
  diskProblemOf,
  productionProblemsIn,
  serviceProblemsOf,
  serviceStatesOf,
} from './health.ts'
import { latestVersion, releaseFileUrlOf, releaseNotesUrlOf } from './release.ts'

const backupDatabases = ['spyria', 'bifrost'] as const
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

export const writeEnvironment = (folder: string, environment: Environment) =>
  writeFileSync(environmentFileOf(folder), serializeEnvironment(environment), { mode: 0o600 })

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

export const backup = async (folder: string, flags: Flags) => {
  const backupsFolder = join(folder, 'backups')
  mkdirSync(backupsFolder, { recursive: true })
  const now = new Date()
  const written: string[] = []
  for (const database of backupDatabases) {
    const path = join(backupsFolder, backupNameOf(database, now))
    const exitCode = await spawnCompose(
      folder,
      ['exec', '-T', 'postgres', 'pg_dump', '-U', 'spyria', '-d', database, '-Fc'],
      {
        stdout: Bun.file(path),
      },
    )
    if (exitCode !== 0) {
      rmSync(path, { force: true })
      throw new Error(`Backing up the ${database} database failed`)
    }
    written.push(path)
  }
  const keep = Number(flags.values.keep ?? defaultBackupsKept)
  for (const file of backupsToRemoveOf(readdirSync(backupsFolder), keep)) rmSync(join(backupsFolder, file))
  for (const path of written) step(`Backed up to ${path}`)
  return written
}

export const restore = async (folder: string, flags: Flags) => {
  const [, file] = flags.positionals
  if (!file) throw new Error('Usage: spyria restore <backups/spyria-….dump>')
  const path = resolve(folder, file)
  const database = backupDatabases.find((candidate) => path.split('/').at(-1)?.startsWith(`${candidate}-`))
  if (!database || !existsSync(path)) throw new Error(`${file} is not a backup of spyria or bifrost`)
  const environment = readEnvironment(folder)
  step('Stopping the server, zero-cache and the gateway')
  mustSucceed(runCompose(folder, ['stop', 'server', 'zero-cache', 'gateway', 'host']), 'Stopping')
  step(`Restoring the ${database} database`)
  const exitCode = await spawnCompose(
    folder,
    ['exec', '-T', 'postgres', 'pg_restore', '-U', 'spyria', '-d', database, '--clean', '--if-exists', '--no-owner'],
    { stdin: Bun.file(path) },
  )
  mustSucceed(exitCode, `Restoring ${file}`)
  if (database === 'spyria') {
    step("Dropping zero-cache's replica, which it rebuilds from the restored database")
    mustSucceed(runCompose(folder, ['rm', '-f', 'zero-cache']), 'Removing zero-cache')
    Bun.spawnSync(['docker', 'volume', 'rm', `${environment.SPYRIA_DEPLOYMENT}-zero-data`])
  }
  mustSucceed(runCompose(folder, ['up', '-d']), 'Starting Spyria')
  await waitForHealth(environment)
  step(`Restored ${file}`)
}

export const upgrade = async (folder: string, flags: Flags) => {
  const environment = readEnvironment(folder)
  const version = flags.positionals[1] ?? (await latestVersion())
  step(`Upgrading from ${environment.SPYRIA_VERSION} to ${version}`)
  await backup(folder, flags)
  const [compose, bifrost] = await Promise.all(
    ['deploy/compose.prod.yml', 'deploy/bifrost.json'].map(async (path) => {
      const response = await fetch(releaseFileUrlOf(version, path))
      if (!response.ok) throw new Error(`Version ${version} has no ${path} (${response.status})`)
      return response.text()
    }),
  )
  writeFileSync(composeFileOf(folder), compose ?? '')
  writeFileSync(join(folder, 'bifrost.json'), bifrost ?? '')
  const upgraded = { ...environment, SPYRIA_VERSION: version }
  writeEnvironment(folder, upgraded)
  await startStack(folder, upgraded)
  console.log(`Spyria ${version} runs. What changed: ${releaseNotesUrlOf(version)}`)
}

export const doctor = (folder: string) => {
  const environment = readEnvironment(folder)
  const problems: string[] = []
  if (Bun.spawnSync(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode !== 0)
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
