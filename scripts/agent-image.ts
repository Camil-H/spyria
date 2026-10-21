import { readFileSync, writeFileSync } from 'node:fs'
import { type HarnessId, harnessIds, installScriptOf } from '../apps/host/src/harnesses.ts'
import { checkLicenses } from './check-licenses.ts'
import { distrustedRootPemPrefixes } from './check-trust.ts'

const agentDirectory = new URL('../apps/agent/', import.meta.url).pathname
const piDirectory = `${agentDirectory}pi/`
const piManifestFile = `${piDirectory}package.json`
const harnessesFile = new URL('../apps/host/src/harnesses.json', import.meta.url).pathname
const testHarnessesVolume = 'spyria-test-harnesses'
type Pinned = { package: string; version: string }
type HarnessPins = Record<HarnessId, { packages: Record<string, string>; executables: Record<string, string> }>
const piManifest = (): { dependencies: Record<string, string> } => JSON.parse(readFileSync(piManifestFile, 'utf8'))
const imageVersions = (): Record<string, Pinned> =>
  Object.fromEntries(
    Object.entries(piManifest().dependencies).map(([packageName, version]) => [
      'pi',
      { package: packageName, version },
    ]),
  )
const harnessPins = (): HarnessPins => JSON.parse(readFileSync(harnessesFile, 'utf8'))
const harnessVersions = () =>
  Object.fromEntries(
    Object.values(harnessPins()).flatMap(({ packages }) =>
      Object.entries(packages).map(([packageName, version]) => [
        packageName.split('/').at(-1),
        { package: packageName, version },
      ]),
    ),
  ) as Record<string, Pinned>
const readVersions = () => ({ ...harnessVersions(), ...imageVersions() })
const run = (command: string[], directory = agentDirectory) => {
  const result = Bun.spawnSync(command, { cwd: directory, stdout: 'pipe', stderr: 'inherit' })
  if (result.exitCode !== 0) process.exit(result.exitCode)
  return result.stdout.toString().trim()
}
const latestOf = (name: string) => run(['npm', 'view', name, 'version'])

const fillTestHarnesses = (image: string) => {
  for (const harness of harnessIds)
    run([
      ...['docker', 'run', '--rm', '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp'],
      ...['--tmpfs', '/home/openhands:uid=10001,gid=10001,mode=0700'],
      ...['--mount', `type=volume,src=${testHarnessesVolume},dst=/harnesses`, '--entrypoint', 'sh', image],
      ...['-c', installScriptOf(harness, '')],
    ])
}

const scrubDistrustedRoots = (file: string) => {
  const binary = readFileSync(file)
  for (const prefix of Object.values(distrustedRootPemPrefixes))
    for (let index = binary.indexOf(prefix); index !== -1; index = binary.indexOf(prefix, index))
      binary.fill('*', index, index + prefix.length)
  writeFileSync(file, binary)
}

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
  scrubDistrustedRoots(`${agentDirectory}dist/spyria-agent`)
  run(['docker', 'build', '--pull', '--iidfile', 'image-id', '-t', 'spyria-agent:dev', '.'])
  const image = readFileSync(`${agentDirectory}image-id`, 'utf8').trim()
  if (!checkLicenses(image)) process.exit(1)
  fillTestHarnesses(image)
  console.log(`Spyria runtime image ${image}`)
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
    const manifest = piManifest()
    manifest.dependencies[pinned.package] = latest
    writeFileSync(piManifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
    run(['npm', 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], piDirectory)
  } else {
    const pins = harnessPins()
    for (const { packages } of Object.values(pins)) if (pinned.package in packages) packages[pinned.package] = latest
    writeFileSync(harnessesFile, `${JSON.stringify(pins, null, 2)}\n`)
  }
  build()
} else throw new Error('Usage: agent-image.ts build | versions | bump <tool>')
