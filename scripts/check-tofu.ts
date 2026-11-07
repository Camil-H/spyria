import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const version = '1.10.6'
const checksums: Record<string, string> = {
  amd64: '15b7bed76420b50da3e121769c43341df8cd57d751ca14e6dbe9c850124c6dac',
  arm64: 'a32f653d686a8cad9b9be82101eb5b5e834fbfa8d095842fa1820c5d27fad967',
}
const repositoryRoot = new URL('../', import.meta.url).pathname
const toolDirectory = join(repositoryRoot, '.check/tofu', version)
const tofuPath = join(toolDirectory, 'tofu')
const pluginCache = join(repositoryRoot, '.check/tofu-plugins')
const tofuRoot = join(repositoryRoot, 'deploy/tofu')

const fileInZip = (zip: Buffer, wanted: string) => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  let entry = zip.readUInt32LE(end + 16)
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    const nameLength = zip.readUInt16LE(entry + 28)
    const name = zip.subarray(entry + 46, entry + 46 + nameLength).toString()
    if (name === wanted) {
      const local = zip.readUInt32LE(entry + 42)
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      const data = zip.subarray(start, start + zip.readUInt32LE(entry + 20))
      return zip.readUInt16LE(entry + 10) === 8 ? inflateRawSync(data) : data
    }
    entry += 46 + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32)
  }
  throw new Error(`${wanted} is not in the archive`)
}

const installTofu = async () => {
  if (existsSync(tofuPath)) return
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
  if (process.platform !== 'linux') throw new Error('check:tofu downloads OpenTofu for Linux only: run it in CI or a Linux runtime')
  const url = `https://github.com/opentofu/opentofu/releases/download/v${version}/tofu_${version}_linux_${architecture}.zip`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Downloading ${url} failed with ${response.status}`)
  const zip = Buffer.from(await response.arrayBuffer())
  if (createHash('sha256').update(zip).digest('hex') !== checksums[architecture])
    throw new Error(`${url} does not match its pinned checksum`)
  mkdirSync(toolDirectory, { recursive: true })
  await Bun.write(tofuPath, fileInZip(zip, 'tofu'))
  chmodSync(tofuPath, 0o755)
}

const configurationsIn = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'tests')
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      const hasConfiguration = readdirSync(path).some((file) => file.endsWith('.tf'))
      return hasConfiguration ? [path] : configurationsIn(path)
    })

const tofu = (directory: string, tofuArguments: string[]) =>
  Bun.spawnSync([tofuPath, ...tofuArguments], {
    cwd: directory,
    env: { ...process.env, TF_PLUGIN_CACHE_DIR: pluginCache, TF_IN_AUTOMATION: '1', NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })

await installTofu()
mkdirSync(pluginCache, { recursive: true })
const failures: string[] = []
const formatted = tofu(tofuRoot, ['fmt', '-check', '-recursive', '-diff'])
if (formatted.exitCode !== 0) failures.push(`tofu fmt: run tofu fmt -recursive deploy/tofu\n${formatted.stdout}`)
for (const directory of configurationsIn(tofuRoot)) {
  const name = directory.slice(repositoryRoot.length)
  const steps = [
    ['init', '-backend=false', '-input=false', '-no-color'],
    ['validate', '-no-color'],
    ...(existsSync(join(directory, 'tests')) ? [['test', '-no-color']] : []),
  ]
  for (const step of steps) {
    const result = tofu(directory, step)
    if (result.exitCode === 0) continue
    failures.push(`${name}: tofu ${step[0]} failed\n${result.stdout}${result.stderr}`)
    break
  }
  console.log(`${failures.some((failure) => failure.startsWith(`${name}:`)) ? '✗' : '✓'} ${name}`)
}
for (const failure of failures) console.error(failure)
process.exit(failures.length === 0 ? 0 : 1)
