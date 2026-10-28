import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repositoryRoot = process.argv[2] ?? new URL('../', import.meta.url).pathname
const hostDirectory = join(repositoryRoot, 'apps/host')
const npmDirectories = ['apps/agent/pi', 'apps/agent/browser']

const isInSync = (directory: string, files: string[], command: string[]) => {
  const copy = mkdtempSync(join(tmpdir(), 'spyria-lock-'))
  for (const file of files) cpSync(join(directory, file), join(copy, file))
  const result = Bun.spawnSync(command, { cwd: copy, stdout: 'ignore', stderr: 'ignore' })
  rmSync(copy, { recursive: true, force: true })
  return result.exitCode === 0
}

const resolvedPackagesOf = (lockFile: string): string[] =>
  Object.values(
    (Bun.JSONC.parse(readFileSync(lockFile, 'utf8')) as { packages: Record<string, string[]> }).packages,
  ).map(([resolved, , , integrity]) => `${resolved} ${integrity}`)

const rootPackages = new Set(resolvedPackagesOf(join(repositoryRoot, 'bun.lock')))
const problems = [
  ...(isInSync(hostDirectory, ['package.json', 'bun.lock'], ['bun', 'install', '--frozen-lockfile', '--lockfile-only'])
    ? []
    : ['apps/host/bun.lock does not match apps/host/package.json']),
  ...resolvedPackagesOf(join(hostDirectory, 'bun.lock'))
    .filter((resolved) => !rootPackages.has(resolved))
    .map((resolved) => `apps/host/bun.lock resolves ${resolved.split(' ')[0]}, which the root bun.lock does not`),
  ...npmDirectories.flatMap((directory) =>
    isInSync(
      join(repositoryRoot, directory),
      ['package.json', 'package-lock.json'],
      ['npm', 'ci', '--dry-run', '--ignore-scripts'],
    )
      ? []
      : [`${directory}/package-lock.json does not match ${directory}/package.json`],
  ),
]
for (const problem of problems) console.error(problem)
if (problems.length > 0) process.exit(1)
console.log(
  `apps/host/bun.lock and the package-lock.json of ${npmDirectories.join(' and ')} match their package.json and the root lockfile`,
)
