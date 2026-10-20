import { readFileSync, writeFileSync } from 'node:fs'
import { harnesses } from '../packages/kernel/src/harnesses.ts'

const agentDirectory = new URL('../apps/agent/', import.meta.url).pathname
const versionsFile = `${agentDirectory}versions.json`
const harnessesFile = new URL('../packages/kernel/src/harnesses.ts', import.meta.url).pathname
type Pinned = { package: string; version: string }
const imageVersions = (): Record<string, Pinned> => JSON.parse(readFileSync(versionsFile, 'utf8'))
const harnessVersions = () =>
  Object.fromEntries(
    Object.values(harnesses).flatMap(({ packages }) =>
      packages.map((pinned) => {
        const separator = pinned.lastIndexOf('@')
        const packageName = pinned.slice(0, separator)
        return [packageName.split('/').at(-1), { package: packageName, version: pinned.slice(separator + 1) }]
      }),
    ),
  ) as Record<string, Pinned>
const readVersions = () => ({ ...harnessVersions(), ...imageVersions() })
const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { cwd: agentDirectory, stdout: 'pipe', stderr: 'inherit' })
  if (result.exitCode !== 0) process.exit(result.exitCode)
  return result.stdout.toString().trim()
}
const latestOf = (name: string) => run(['npm', 'view', name, 'version'])

const build = () => {
  const architecture = run(['docker', 'info', '--format', '{{.Architecture}}']) === 'aarch64' ? 'arm64' : 'x64'
  run([
    'bun',
    'build',
    '--compile',
    '--minify',
    `--target=bun-linux-${architecture}`,
    'src/main.ts',
    '--outfile',
    'dist/spyria-agent',
  ])
  const packages = Object.values(readVersions())
    .map((tool) => `${tool.package}@${tool.version}`)
    .join(' ')
  run([
    'docker',
    'build',
    '--iidfile',
    'image-id',
    '-t',
    'spyria-agent:dev',
    '--build-arg',
    `PACKAGES=${packages}`,
    '.',
  ])
  console.log(`Spyria runtime image ${readFileSync(`${agentDirectory}image-id`, 'utf8').trim()}`)
}

const [command, tool] = process.argv.slice(2)
if (command === 'build') build()
else if (command === 'versions')
  for (const [name, { package: packageName, version }] of Object.entries(readVersions())) {
    const latest = latestOf(packageName)
    console.log(
      `${name.padEnd(18)}${version.padEnd(10)}${latest.padEnd(10)}${latest === version ? '' : 'update available'}`,
    )
  }
else if (command === 'bump') {
  const versions = readVersions()
  const pinned = versions[tool ?? '']
  if (!pinned) throw new Error(`Unknown tool ${tool}; choose from ${Object.keys(versions).join(', ')}`)
  const latest = latestOf(pinned.package)
  if (tool && tool in imageVersions()) {
    const pinnedInImage = imageVersions()
    pinnedInImage[tool] = { ...pinned, version: latest }
    writeFileSync(versionsFile, `${JSON.stringify(pinnedInImage, null, 2)}\n`)
  } else
    writeFileSync(
      harnessesFile,
      readFileSync(harnessesFile, 'utf8').replace(
        `'${pinned.package}@${pinned.version}'`,
        `'${pinned.package}@${latest}'`,
      ),
    )
  build()
} else throw new Error('Usage: agent-image.ts build | versions | bump <tool>')
