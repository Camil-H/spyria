import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, restore } from './commands.ts'
import { composeCommandOf } from './compose.ts'
import { serializeEnvironment } from './environment.ts'
import { parseFlags } from './flags.ts'

const hasDocker =
  Bun.which('docker') !== null &&
  Bun.spawnSync(['docker', 'info'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
if (!hasDocker) console.warn('Skipping the backup Docker test: Docker is unavailable')
const deployment = `spyria-test-backup-${crypto.randomUUID().slice(0, 8)}`
const folder = mkdtempSync(join(tmpdir(), `${deployment}-`))
const health = Bun.serve({ port: 0, fetch: () => new Response('ok') })
const sleeper = (name: string) => `  ${name}:\n    image: postgres:18\n    entrypoint: [sleep, infinity]\n`
writeFileSync(
  join(folder, 'compose.yml'),
  [
    `name: ${deployment}`,
    'services:',
    '  postgres:',
    '    image: postgres:18',
    '    environment: { POSTGRES_USER: spyria, POSTGRES_PASSWORD: test, POSTGRES_DB: spyria }',
    '    healthcheck: { test: pg_isready -U spyria -d spyria, interval: 1s, retries: 60 }',
    sleeper('server'),
    sleeper('zero-cache'),
    sleeper('gateway'),
  ].join('\n'),
)
writeFileSync(
  join(folder, '.env'),
  serializeEnvironment({ SPYRIA_DEPLOYMENT: deployment, SPYRIA_LOCAL_PORT: String(health.port) }),
)
const compose = (...composeArguments: string[]) =>
  Bun.spawnSync(composeCommandOf(folder, composeArguments), { cwd: folder, stdout: 'pipe', stderr: 'pipe' })
const sql = (database: string, statement: string) => {
  const result = compose('exec', '-T', 'postgres', 'psql', '-U', 'spyria', '-d', database, '-tAc', statement)
  if (result.exitCode !== 0) throw new Error(`${statement} failed: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

afterAll(() => {
  if (hasDocker) compose('down', '--volumes', '--timeout', '1')
  health.stop(true)
  rmSync(folder, { recursive: true, force: true })
})

test.skipIf(!hasDocker)(
  'a backup is private and restores each database whole: rows written after it, and tables a later migration added, are gone, and the gateway keeps owning its tables',
  async () => {
    expect(compose('up', '-d', '--wait').exitCode).toBe(0)
    sql('spyria', "create table notes (body text); insert into notes values ('before')")
    sql('spyria', "create role bifrost login password 'test'")
    sql('spyria', 'create database bifrost owner bifrost')
    expect(
      compose('exec', '-T', 'postgres', 'psql', '-U', 'bifrost', '-d', 'bifrost', '-c', 'create table keys (id int)')
        .exitCode,
    ).toBe(0)
    const written = await backup(folder, parseFlags(['backup', '--keep', '2']))
    expect(written).toHaveLength(2)
    expect(statSync(join(folder, 'backups')).mode & 0o777).toBe(0o700)
    for (const path of written) expect(statSync(path).mode & 0o777).toBe(0o600)

    sql('spyria', "insert into notes values ('after'); create table added_later (id int)")
    const [spyriaDump, bifrostDump] = written.map((path) => path.split('/').at(-1) ?? '')
    const whole = await Bun.file(written[0] ?? '').bytes()
    mkdirSync(join(folder, 'unusable'))
    writeFileSync(join(folder, 'unusable', 'spyria-truncated.dump'), whole.subarray(0, Math.floor(whole.length / 2)))
    writeFileSync(join(folder, 'unusable', 'spyria-plain.dump'), 'create table notes (body text);\n')
    for (const unusable of ['unusable/spyria-truncated.dump', 'unusable/spyria-plain.dump'])
      expect(await restore(folder, parseFlags(['restore', unusable])).catch((error: Error) => error.message)).toBe(
        `${unusable} is not a complete backup made by spyria backup: nothing was changed`,
      )
    expect(sql('spyria', "select string_agg(body, ',' order by body) from notes")).toBe('after,before')
    expect(compose('stop', 'postgres').exitCode).toBe(0)
    expect(
      await restore(folder, parseFlags(['restore', `backups/${spyriaDump}`])).catch((error: Error) => error.message),
    ).toBe('Postgres is not running: start it with spyria compose up -d postgres, then restore again')
    expect(compose('up', '-d', '--wait', 'postgres').exitCode).toBe(0)
    await restore(folder, parseFlags(['restore', `backups/${spyriaDump}`]))
    expect(sql('spyria', "select string_agg(body, ',') from notes")).toBe('before')
    expect(sql('spyria', "select to_regclass('added_later') is null")).toBe('t')

    await restore(folder, parseFlags(['restore', `backups/${bifrostDump}`]))
    expect(sql('bifrost', "select tableowner from pg_tables where tablename = 'keys'")).toBe('bifrost')

    await backup(folder, parseFlags(['backup', '--keep', '1']))
    expect(readdirSync(join(folder, 'backups')).filter((file) => file.startsWith('spyria-'))).toHaveLength(1)
    expect(await backup(folder, parseFlags(['backup', '--keep', '0'])).catch((error: Error) => error.message)).toBe(
      '--keep takes a whole number of backups, at least 1',
    )
  },
  180_000,
)
