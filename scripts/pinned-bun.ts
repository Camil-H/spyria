import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { scrubDistrustedRoots } from './check-trust.ts'

export const pinnedBunVersion = '1.3.14'
export const pinnedBunImage = `oven/bun:${pinnedBunVersion}-slim`
const releaseSha256 = {
  'bun-darwin-aarch64': 'd8b96221828ad6f97ac7ac0ab7e95872341af763001e8803e8267652c2652620',
  'bun-darwin-x64': '4183df3374623e5bab315c547cfa0974533cd457d86b73b639f7a87974cd6633',
  'bun-linux-aarch64': 'a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b',
  'bun-linux-x64': '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f',
}
const repositoryRoot = new URL('../', import.meta.url).pathname
const cacheDirectory = `${repositoryRoot}node_modules/.cache/spyria-bun/${pinnedBunVersion}/`

for (const dockerfile of ['apps/server/Dockerfile', 'apps/host/Dockerfile'])
  if (!readFileSync(`${repositoryRoot}${dockerfile}`, 'utf8').includes(`FROM ${pinnedBunImage}`))
    throw new Error(`${dockerfile} does not build on ${pinnedBunImage}: keep scripts/pinned-bun.ts in step`)

const run = (command: string[]) => {
  const result = Bun.spawnSync(command, { stdout: 'ignore', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed: ${result.stderr.toString().trim()}`)
}

export const pinnedBunPath = async () => {
  if (Bun.version === pinnedBunVersion) return process.execPath
  const binary = `${cacheDirectory}bun`
  if (existsSync(binary)) return binary
  const asset = `bun-${process.platform}-${process.arch === 'arm64' ? 'aarch64' : 'x64'}` as keyof typeof releaseSha256
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${pinnedBunVersion}/${asset}.zip`
  const archive = await fetch(url).then((response) => {
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
    return response.bytes()
  })
  if (new Bun.CryptoHasher('sha256').update(archive).digest('hex') !== releaseSha256[asset])
    throw new Error(`${url} does not match its pinned SHA-256`)
  mkdirSync(cacheDirectory, { recursive: true })
  const staging = mkdtempSync(join(cacheDirectory, 'download-'))
  try {
    await Bun.write(`${staging}/bun.zip`, archive)
    run(['unzip', '-q', '-j', `${staging}/bun.zip`, `${asset}/bun`, '-d', staging])
    scrubDistrustedRoots(`${staging}/bun`)
    chmodSync(`${staging}/bun`, 0o755)
    if (process.platform === 'darwin') run(['codesign', '--force', '--sign', '-', `${staging}/bun`])
    renameSync(`${staging}/bun`, binary)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return binary
}

if (import.meta.main) {
  const child = Bun.spawn([await pinnedBunPath(), ...process.argv.slice(2)], {
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal))
  process.exit(await child.exited)
}
